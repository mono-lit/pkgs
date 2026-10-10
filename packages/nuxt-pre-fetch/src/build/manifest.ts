import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { NuxtPage } from '@nuxt/schema'
import type { Manifest, ManifestRequest, ManifestRoute } from '../runtime/shared/types'
import type { ImportBinding, ModuleAnalysis, PageAnalysis } from './analyzer'
import { analyzeModule, analyzeSFC } from './analyzer'
import { compareRouteScore, compileRoutePath, flattenPages } from './routes'

export interface ManifestWarning {
  file: string
  line: number
  message: string
}

/** An auto-imported name (Nuxt `imports`): where it comes from. */
export interface AutoImport {
  from: string
  imported: string
}

/** Resolves an import specifier of `fromFile` to a source file, or `null` (packages, unknown). */
export type ImportResolver = (source: string, fromFile: string) => string | null

/** How deep stores/composables calling other stores/composables are followed. */
const MAX_PROVIDER_DEPTH = 6
const MODULE_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.tsx', '.jsx']

function requestSignature(request: ManifestRequest): string {
  return JSON.stringify([request.url, request.query ?? {}, request.headers ?? {}, request.pick ?? null, request.each ?? null, request.store ?? null])
}

/**
 * Default resolver: applies the given aliases (`~`, `@`, `#imports`…), resolves
 * relative paths, and probes file extensions and `index` files. Bare package
 * specifiers resolve to `null`: only the app's own sources are analysed.
 */
export function createImportResolver(aliases: Record<string, string>): ImportResolver {
  const keys = Object.keys(aliases).sort((a, b) => b.length - a.length)
  /** Only the app's own sources: framework/library internals are never analysed. */
  const own = (file: string): string | null => {
    const normalized = resolve(file) // one spelling per file (slashes, `..`) for caching
    return /[\\/]node_modules[\\/]/.test(normalized) ? null : normalized
  }
  const probe = (base: string): string | null => {
    if (/\.[cm]?[jt]sx?$/.test(base) && existsSync(base)) return own(base)
    for (const extension of MODULE_EXTENSIONS) if (existsSync(base + extension)) return own(base + extension)
    for (const extension of MODULE_EXTENSIONS) if (existsSync(resolve(base, `index${extension}`))) return own(resolve(base, `index${extension}`))
    return null
  }
  return (source, fromFile) => {
    for (const key of keys) {
      if (source === key || source.startsWith(`${key}/`)) return probe(aliases[key]! + source.slice(key.length))
    }
    if (source.startsWith('.')) return probe(resolve(dirname(fromFile), source))
    if (/^[A-Z]:[\\/]|^\//i.test(source)) return probe(source)
    return null
  }
}

/**
 * Build-time state: the page tree plus a per-file analysis cache. Files are
 * re-analysed only when their mtime changes, so dev rebuilds stay cheap and the
 * server never scans sources at request time.
 *
 * Pages are followed into the stores and composables they call while they set up
 * (`useUsersStore()`, `useUsers()`), through explicit imports or Nuxt auto-imports,
 * so `usePreFetch()` inside a Pinia setup store or a composable is prefetched too.
 */
export class ManifestBuilder {
  private pages: NuxtPage[] = []
  private pageCache = new Map<string, { mtime: number, result: PageAnalysis }>()
  private moduleCache = new Map<string, { mtime: number, result: ModuleAnalysis }>()
  private autoImports = new Map<string, AutoImport>()
  /** Store/composable files the last build read: edits to them rebuild the manifest. */
  private dependencies = new Set<string>()

  constructor(
    private readonly rootDir: string,
    private readonly resolveImport: ImportResolver = () => null,
  ) {}

  setPages(pages: NuxtPage[]): void {
    this.pages = pages
  }

  /** Nuxt's auto-import registry (`imports:context` → `getImports()`). */
  setAutoImports(imports: Array<{ name: string, as?: string, from: string }>): void {
    this.autoImports = new Map(imports.map(entry => [entry.as ?? entry.name, { from: entry.from, imported: entry.name }]))
  }

  get pageFiles(): Set<string> {
    const files = new Set<string>()
    for (const route of flattenPages(this.pages)) for (const file of route.files) files.add(file)
    return files
  }

  /** Every file the manifest depends on (normalised paths): pages plus the stores/composables they use. */
  get watchedFiles(): Set<string> {
    return new Set([...this.pageFiles, ...this.dependencies].map(file => resolve(file)))
  }

  /** Forgets a file (any path spelling) so the next build re-reads it. */
  invalidate(file: string): void {
    const target = resolve(file)
    for (const cache of [this.pageCache, this.moduleCache] as Array<Map<string, unknown>>) {
      for (const key of [...cache.keys()]) if (resolve(key) === target) cache.delete(key)
    }
  }

  private relative(file: string): string {
    return relative(this.rootDir, file).replace(/\\/g, '/')
  }

  private cached<T>(cache: Map<string, { mtime: number, result: T }>, file: string, analyze: (source: string) => T): T | null {
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    }
    catch {
      return null
    }
    const hit = cache.get(file)
    if (hit && hit.mtime === mtime) return hit.result
    const result = analyze(readFileSync(file, 'utf8'))
    cache.set(file, { mtime, result })
    return result
  }

  analyze(file: string): PageAnalysis {
    return this.cached(this.pageCache, file, source => analyzeSFC(source, this.relative(file)))
      ?? { requests: [], warnings: [], calls: [], imports: {} }
  }

  analyzeModuleFile(file: string): ModuleAnalysis | null {
    return this.cached(this.moduleCache, file, source => analyzeModule(source, this.relative(file)))
  }

  /** Where a call `name` made in `fromFile` (with its imports) leads: file + exported name. */
  private locate(name: string, imports: Record<string, ImportBinding>, fromFile: string): { file: string, exported: string } | null {
    const binding = imports[name]
    if (binding) {
      const file = this.resolveImport(binding.source, fromFile)
      return file ? { file, exported: binding.imported } : null
    }
    const auto = this.autoImports.get(name)
    if (auto) {
      const file = this.resolveImport(auto.from, fromFile)
      return file ? { file, exported: auto.imported } : null
    }
    return null
  }

  /**
   * Requests reached by calling `name` from `fromFile`: the provider's own setup-time
   * `usePreFetch()` calls, then whatever it calls in turn (depth- and cycle-limited).
   */
  private followCall(
    name: string,
    imports: Record<string, ImportBinding>,
    fromFile: string,
    store: string | undefined,
    depth: number,
    visited: Set<string>,
    out: { requests: ManifestRequest[], warnings: ManifestWarning[] },
  ): void {
    if (depth > MAX_PROVIDER_DEPTH) return
    const target = this.locate(name, imports, fromFile)
    if (!target) return
    const analysis = this.analyzeModuleFile(target.file)
    if (!analysis) return
    const local = analysis.exports[target.exported] ?? (target.exported === 'default' ? undefined : target.exported)
    this.followProvider(target.file, analysis, local, store, depth, visited, out)
  }

  private followProvider(
    file: string,
    analysis: ModuleAnalysis,
    local: string | undefined,
    store: string | undefined,
    depth: number,
    visited: Set<string>,
    out: { requests: ManifestRequest[], warnings: ManifestWarning[] },
  ): void {
    const provider = local ? analysis.providers[local] : undefined
    const key = `${file}#${local}`
    if (!provider || visited.has(key)) return
    visited.add(key)
    this.dependencies.add(file)
    // A request inside a setup store belongs to that store (also through composables it uses).
    const owner = store ?? provider.storeId
    for (const request of provider.requests) out.requests.push(owner ? { ...request, store: owner } : request)
    for (const warning of provider.warnings) out.warnings.push({ file: this.relative(file), ...warning })
    for (const call of provider.calls) {
      // Same-module helpers first, then imports / auto-imports.
      if (analysis.providers[call.name]) this.followProvider(file, analysis, call.name, owner, depth + 1, visited, out)
      else this.followCall(call.name, analysis.imports, file, owner, depth + 1, visited, out)
    }
  }

  build(): { manifest: Manifest, warnings: ManifestWarning[] } {
    const warnings: ManifestWarning[] = []
    const routes: Array<ManifestRoute & { score: number[] }> = []
    const reported = new Set<string>()
    this.dependencies = new Set()

    for (const route of flattenPages(this.pages)) {
      const requests: ManifestRequest[] = []
      const seen = new Set<string>()
      const add = (request: ManifestRequest) => {
        const signature = requestSignature(request)
        if (seen.has(signature)) return
        seen.add(signature)
        requests.push(request)
      }
      for (const file of route.files) {
        const result = this.analyze(file)
        const report = !reported.has(file)
        reported.add(file)
        if (report) for (const warning of result.warnings) warnings.push({ file: this.relative(file), ...warning })
        for (const request of result.requests) add(request)

        // Stores and composables this page uses while it sets up.
        const followed = { requests: [] as ManifestRequest[], warnings: [] as ManifestWarning[] }
        const visited = new Set<string>()
        for (const call of result.calls) this.followCall(call.name, result.imports, file, undefined, 0, visited, followed)
        for (const request of followed.requests) add(request)
        if (report) warnings.push(...followed.warnings)
      }
      if (!requests.length) continue
      const compiled = compileRoutePath(route.path)
      if (!compiled) {
        warnings.push({ file: route.files.at(-1) ?? route.path, line: 1, message: `route ${route.path} uses path syntax the prefetch matcher does not support; its requests fall back to client fetches.` })
        continue
      }
      routes.push({ pattern: route.path, re: compiled.re, params: compiled.params, requests, score: compiled.score })
    }

    routes.sort((a, b) => compareRouteScore(a.score, b.score))
    // The same store/composable warning can be reached from several pages: report it once.
    const unique = new Map(warnings.map(w => [`${w.file}:${w.line}:${w.message}`, w]))
    return {
      manifest: { routes: routes.map(({ score: _score, ...route }) => route) },
      warnings: [...unique.values()],
    }
  }
}

export function serverManifestCode(manifest: Manifest): string {
  return `export const manifest = ${JSON.stringify(manifest)}\n`
}

/** Client side only learns *which* routes prefetch — never URLs or headers. */
export function clientRoutesCode(manifest: Manifest): string {
  const list = manifest.routes.map(route => `new RegExp(${JSON.stringify(route.re)}, 'i')`).join(',\n  ')
  return `export const routes = [\n  ${list}\n]\n`
}
