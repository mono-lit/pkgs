// `definePrefetch()` files: found at build time, bundled into Nitro through a virtual module.
//
// The route pattern (first argument) is read from the source so the client knows which routes
// to prefetch on navigation; the handler itself only ever runs on the server.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ManifestRouteParam } from '../runtime/shared/types'
import { compileRoutePath } from './routes'

export interface ScannedDefinition {
  file: string
  pattern: string
  re: string
  params: ManifestRouteParam[]
}

const SCRIPT = /\.[cm]?[jt]s$/
const PATTERN = /\bdefinePrefetch\s*\(\s*(['"`])([^'"`$]+)\1/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (SCRIPT.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** `/users/:id` → `/users/:id()` (Nuxt's form, what `compileRoutePath` reads). */
function toNuxtPath(pattern: string): string {
  return pattern.replace(/:(\w+)(?!\(|\w)/g, ':$1()')
}

export function scanDefinitions(dir: string): { definitions: ScannedDefinition[], warnings: string[] } {
  const definitions: ScannedDefinition[] = []
  const warnings: string[] = []
  if (!existsSync(dir)) return { definitions, warnings }
  for (const file of walk(dir)) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('definePrefetch')) continue
    const match = PATTERN.exec(source)
    if (!match) {
      warnings.push(`${file}: definePrefetch() needs a string literal route pattern as its first argument; skipped.`)
      continue
    }
    const pattern = match[2]!.trim()
    const compiled = compileRoutePath(toNuxtPath(pattern))
    if (!compiled) {
      warnings.push(`${file}: unsupported route pattern '${pattern}'; skipped.`)
      continue
    }
    definitions.push({ file, pattern, re: compiled.re, params: compiled.params })
  }
  return { definitions, warnings }
}

/** The Nitro virtual module: each definition with its compiled route matcher. */
export function definitionsCode(definitions: ScannedDefinition[]): string {
  const imports = definitions.map((d, i) => `import d${i} from ${JSON.stringify(d.file.replace(/\\/g, '/'))}`)
  const entries = definitions.map((d, i) => `  { pattern: ${JSON.stringify(d.pattern)}, re: ${JSON.stringify(d.re)}, params: ${JSON.stringify(d.params)}, definition: d${i} },`)
  return [...imports, 'export const definitions = [', ...entries, ']'].join('\n')
}
