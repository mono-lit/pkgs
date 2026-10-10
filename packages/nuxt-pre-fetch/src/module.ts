import { relative, resolve } from 'node:path'
import {
  addImports,
  addPlugin,
  addRouteMiddleware,
  addServerHandler,
  addServerImports,
  addServerPlugin,
  addServerTemplate,
  addTemplate,
  addTypeTemplate,
  createResolver,
  defineNuxtModule,
  updateTemplates,
  useLogger,
  useNitro,
} from '@nuxt/kit'
import { defu } from 'defu'
import type { NuxtModule } from '@nuxt/schema'
import type { DynamicRequestOptions, ExternalHostOptions, LearnOptions, PrivateRuntimeOptions, PublicRuntimeOptions } from './runtime/shared/types'
import { definitionsCode, scanDefinitions, type ScannedDefinition } from './build/definitions'
import { staticReason } from './build/static'
import { clientRoutesCode, createImportResolver, ManifestBuilder, serverManifestCode } from './build/manifest'

export interface ModuleOptions {
  /** Turn the module off; `usePreFetch` then behaves exactly like `useFetch`. @default true */
  enabled: boolean
  /** Log cache hits/misses and prefetch durations (server and browser). @default false */
  debug: boolean
  /** Prefetch through Nitro on `<NuxtLink>`/router navigation. @default true */
  clientNavigation: boolean
  /**
   * Where `refresh()`/watch re-fetches run:
   * - `'client'`: the browser calls the API directly (like `useFetch`).
   * - `'server'`: the browser asks the prefetch endpoint, which runs the
   *   request on Nitro — the browser never calls the backend for prefetchable requests.
   * @default 'client'
   */
  fetchMode: 'client' | 'server'
  /**
   * In `fetchMode: 'server'`, what happens to a request that was not
   * discovered at build time: `'client'` fetches it from the browser,
   * `'error'` fails it.
   * @default 'client'
   */
  fallback: 'client' | 'error'
  /** Max requests run in parallel per page prefetch. @default 6 */
  concurrency: number
  /**
   * Max items of a list query prefetched per call (`String(route.query.ids).split(',').map(id => usePreFetch(...))`).
   * Bounds how many server requests one URL can trigger; extra items are fetched by the browser.
   * `0` = unlimited: then ANY visitor can make the server fire as many requests as they put
   * in the URL. Only do that when the list is trusted or the upstream API can take it.
   * @default 20
   */
  maxListItems: number
  /** Per-request timeout on the server in ms; slower requests are left to the browser. @default 5000 */
  timeout: number
  /**
   * Client navigation streams the prefetch: each result is sent the moment its request
   * finishes, the navigation only waits until the stream starts, and every usePreFetch waits
   * for its own result. `false`: one response with all results, the navigation waits for it.
   * @default true
   */
  streamNavigation: boolean
  /** Max time a client navigation waits for its prefetch before rendering, in ms. @default 3000 */
  navigationTimeout: number
  /**
   * Keep the `<script type="application/json" id="__NUXT_PRE_FETCH__">` element in the
   * DOM after the client has read it (e.g. for debugging or other scripts). By default it
   * is removed as soon as it is parsed; the data is used from memory either way.
   * @default false
   */
  keepPayload: boolean
  /** Route of the prefetch endpoint. @default '/__nuxt_pre_fetch' */
  endpoint: string
  /** Absolute-URL (external API) requests. Off unless a host is listed. */
  external: Partial<ExternalHostOptions>
  /**
   * Runtime requests — declared per page with `definePrefetch()` (files in
   * `<srcDir>/prefetch/`) or learned: where they may go and how much. Other modules may append
   * `allowedHosts` / `authCookies` / `forwardHeaders` through `runtimeConfig.nuxtPreFetch.dynamic`
   * at build time.
   */
  dynamic: Partial<DynamicRequestOptions>
  /**
   * Learned requests: requests a library reports from the browser through
   * `useNuxtApp().$nuxtPreFetch.learn()`. Nitro remembers them per browser + page and replays
   * them on the NEXT visit of that page. Only requests are stored, never data. Off by default;
   * `definePrefetch()` covers the first visit without learning.
   */
  learn: Partial<LearnOptions>
  /**
   * Directory (relative to `srcDir`, or absolute) holding `definePrefetch()` files — or several, e.g. one
   * per app whose pages this app compiles (other modules may append to it). @default 'prefetch'
   */
  prefetchDir: string | string[]
  /**
   * A prefetch that fails on the server (HTTP error, timeout, network, too large):
   * - `'retry'`: the failure is sent to the browser, which stops waiting and fetches the
   *   request itself — with the page's own error handling (token refresh, notifications).
   * - `'embed'`: a usePreFetch request's 4xx is handed to the page as its error, without a
   *   browser request (runtime requests are always retried).
   * @default 'retry'
   */
  serverErrors: 'retry' | 'embed'
}

const NAME = '@mono-lit/nuxt-pre-fetch'

const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({
  meta: {
    name: NAME,
    configKey: 'nuxtPreFetch',
    compatibility: { nuxt: '>=3.17.0' },
  },
  defaults: {
    enabled: true,
    debug: false,
    clientNavigation: true,
    fetchMode: 'client',
    fallback: 'client',
    concurrency: 6,
    maxListItems: 20,
    timeout: 5000,
    navigationTimeout: 3000,
    keepPayload: false,
    streamNavigation: true,
    endpoint: '/__nuxt_pre_fetch',
    external: { allowedHosts: [], forwardHeaders: {} },
    dynamic: {
      allowedHosts: [],
      authCookies: [],
      forwardHeaders: ['accept'],
      maxRequestsPerPage: 40,
      maxEntryBytes: 2_000_000,
    },
    learn: {
      enabled: false,
      maxPages: 50,
      ttl: 7 * 24 * 60 * 60,
    },
    prefetchDir: 'prefetch',
    serverErrors: 'retry',
  },
  setup(options, nuxt) {
    const logger = useLogger('nuxt-pre-fetch')
    const resolver = createResolver(import.meta.url)

    // Static output (`nuxi generate`, or a static Nitro preset) has no server at request time;
    // SSR apps already fetch on the server.
    const staticWhy = staticReason(nuxt.options as Parameters<typeof staticReason>[0])
    const active = options.enabled && nuxt.options.ssr === false && !staticWhy && nuxt.options.pages !== false
    if (options.enabled && !active) {
      const reason = nuxt.options.ssr !== false
        ? 'ssr is enabled (useFetch already runs on the server)'
        : staticWhy ?? 'the pages directory is disabled'
      logger.info(`server prefetching disabled: ${reason}. usePreFetch() behaves like useFetch().`)
    }

    const publicOptions: PublicRuntimeOptions = {
      enabled: active,
      debug: options.debug,
      clientNavigation: options.clientNavigation,
      fetchMode: options.fetchMode,
      fallback: options.fallback,
      endpoint: options.endpoint,
      navigationTimeout: options.navigationTimeout,
      keepPayload: options.keepPayload,
      streamNavigation: options.streamNavigation,
      learn: !!options.learn?.enabled,
      serverErrors: options.serverErrors === 'embed' ? 'embed' : 'retry',
    }
    const privateOptions: PrivateRuntimeOptions = {
      concurrency: options.concurrency,
      maxListItems: options.maxListItems,
      timeout: options.timeout,
      external: {
        allowedHosts: options.external?.allowedHosts ?? [],
        forwardHeaders: options.external?.forwardHeaders ?? {},
      },
      dynamic: {
        allowedHosts: options.dynamic?.allowedHosts ?? [],
        authCookies: options.dynamic?.authCookies ?? [],
        forwardHeaders: options.dynamic?.forwardHeaders ?? ['accept'],
        maxRequestsPerPage: options.dynamic?.maxRequestsPerPage ?? 40,
        maxEntryBytes: options.dynamic?.maxEntryBytes ?? 2_000_000,
      },
      learn: {
        enabled: !!options.learn?.enabled,
        maxPages: options.learn?.maxPages ?? 50,
        ttl: options.learn?.ttl ?? 7 * 24 * 60 * 60,
      },
    }
    const runtimeConfig = nuxt.options.runtimeConfig as Record<string, any>
    runtimeConfig.public.nuxtPreFetch = defu(runtimeConfig.public.nuxtPreFetch, publicOptions)
    runtimeConfig.nuxtPreFetch = defu(runtimeConfig.nuxtPreFetch, privateOptions)

    addImports({ name: 'usePreFetch', from: resolver.resolve('./runtime/composables/usePreFetch') })
    if (!active) return

    // Safety net: a preset can still resolve to static output (e.g. picked by the environment, or
    // set by another module after this one). Then the built page must not try to talk to a server
    // that won't exist: switch the client side off in the config the static HTML carries.
    // (`ready` runs once Nitro is initialised, so its resolved preset is known.)
    nuxt.hook('ready', () => {
      if (nuxt.options.dev) return
      const nitro = useNitro()
      if (!nitro.options.static) return
      logger.warn(`server prefetching disabled: Nitro resolved the static preset "${nitro.options.preset}", which has no request-time server. usePreFetch() behaves like useFetch().`)
      const disable = (config: Record<string, any> | undefined) => {
        const current = config?.public?.nuxtPreFetch
        if (current) Object.assign(current, { enabled: false, learn: false })
      }
      disable(nitro.options.runtimeConfig as Record<string, any>)
      disable(nuxt.options.runtimeConfig as Record<string, any>)
    })

    // Pages are followed into the stores/composables they call; imports resolve through
    // Nuxt's aliases, auto-imported names through Nuxt's import registry.
    const builder = new ManifestBuilder(nuxt.options.rootDir, createImportResolver(nuxt.options.alias))
    let unimport: { getImports: () => Promise<Array<{ name: string, as?: string, from: string }>> } | undefined
    nuxt.hook('imports:context', (context) => {
      unimport = context as unknown as typeof unimport
    })
    const refreshAutoImports = async () => {
      if (unimport) builder.setAutoImports(await unimport.getImports())
    }
    const prefetchDirs = [...new Set((Array.isArray(options.prefetchDir) ? options.prefetchDir : [options.prefetchDir || 'prefetch'])
      .filter(Boolean)
      .map(dir => resolve(nuxt.options.srcDir, dir)))]
    const inPrefetchDir = (file: string) => prefetchDirs.some(dir => file.startsWith(dir))
    let declared: ScannedDefinition[] = []
    const rescanDefinitions = () => {
      const definitions: ScannedDefinition[] = []
      for (const dir of prefetchDirs) {
        const result = scanDefinitions(dir)
        for (const warning of result.warnings) logger.warn(warning)
        definitions.push(...result.definitions)
      }
      const changed = JSON.stringify(definitions) !== JSON.stringify(declared)
      declared = definitions
      if (options.debug && changed) logger.info(`definePrefetch: ${declared.map(d => `${d.pattern} (${relative(nuxt.options.rootDir, d.file).replace(/\\/g, '/')})`).join(', ') || 'none'}`)
      return changed
    }
    rescanDefinitions()
    let current = builder.build()
    let lastServerCode = serverManifestCode(current.manifest)

    const report = (warnings = current.warnings) => {
      for (const warning of warnings) logger.warn(`${warning.file}:${warning.line} ${warning.message}`)
    }
    const rebuild = () => {
      current = builder.build()
      const code = serverManifestCode(current.manifest)
      const changed = code !== lastServerCode
      lastServerCode = code
      return changed
    }

    // Dev: once Nitro runs, a changed manifest needs the client route list regenerated
    // and Nitro reloaded (the server manifest is a virtual module of its bundle).
    let devServerReady = false
    let devSyncPending = false
    const syncDevServer = async () => {
      if (!nuxt.options.dev || !devServerReady) return
      devSyncPending = false
      await updateTemplates({ filter: template => template.filename === 'nuxt-pre-fetch/routes.mjs' })
      await useNitro().hooks.callHook('rollup:reload')
      if (options.debug) logger.info('prefetch manifest updated')
    }
    nuxt.hook('ready', () => {
      devServerReady = true
    })

    // Also fires again in dev whenever pages are added, removed or renamed.
    nuxt.hook('pages:resolved', async (pages) => {
      builder.setPages(pages)
      await refreshAutoImports()
      const changed = rebuild()
      report()
      if (options.debug) {
        logger.info(`prefetch manifest: ${current.manifest.routes.map(r => `${r.pattern} (${r.requests.length})`).join(', ') || 'empty'}`)
      }
      // Applied after Nuxt finishes regenerating its templates (see app:templatesGenerated).
      if (changed && devServerReady) devSyncPending = true
    })
    nuxt.hook('app:templatesGenerated', async () => {
      if (devSyncPending) await syncDevServer()
    })

    // Server-only: request URLs/headers never reach the client bundle.
    addServerTemplate({
      filename: '#nuxt-pre-fetch/manifest',
      getContents: () => serverManifestCode(current.manifest),
    })
    addTemplate({
      filename: 'nuxt-pre-fetch/routes.mjs',
      getContents: () => clientRoutesCode({ routes: [...current.manifest.routes, ...declared.map(d => ({ pattern: d.pattern, re: d.re, params: d.params, requests: [] }))] }),
    })
    // `definePrefetch()` files, bundled into Nitro.
    addServerTemplate({
      filename: '#nuxt-pre-fetch/definitions',
      getContents: () => definitionsCode(declared),
    })
    // Ambient declarations of the virtual modules (script files: no top-level
    // import, or `declare module` would become an augmentation). Both contexts
    // need them: Nuxt's typed-$fetch route map pulls the endpoint handler into
    // the app type context too.
    const manifestType = `import(${JSON.stringify(resolver.resolve('./runtime/shared/types'))}).Manifest`
    const defineModule = JSON.stringify(resolver.resolve('./runtime/server/utils/define'))
    addTypeTemplate({
      filename: 'types/nuxt-pre-fetch.d.ts',
      getContents: () => [
        `declare module '#build/nuxt-pre-fetch/routes.mjs' { export const routes: RegExp[] }`,
        `declare module '#nuxt-pre-fetch/manifest' { export const manifest: ${manifestType} }`,
        `declare module '#nuxt-pre-fetch/definitions' { export const definitions: Array<{ pattern: string, re: string, params: Array<{ name: string, repeat: boolean }>, definition: import(${defineModule}).PrefetchDefinition }> }`,
      ].join('\n'),
    }, { nuxt: true, nitro: true })
    // `definePrefetch` is a Nitro auto-import; prefetch files live in srcDir, so declare it for the app context too.
    addTypeTemplate({
      filename: 'types/nuxt-pre-fetch-define.d.ts',
      getContents: () => [
        `declare global { const definePrefetch: typeof import(${defineModule}).definePrefetch }`,
        'export {}',
      ].join('\n'),
    }, { nuxt: true, nitro: true })
    // Typed `nuxt-pre-fetch:request` Nitro runtime hook (module augmentation).
    addTypeTemplate({
      filename: 'types/nuxt-pre-fetch-nitro.d.ts',
      getContents: () => {
        const context = `import(${JSON.stringify(resolver.resolve('./runtime/server/utils/runner'))}).PreFetchRequestContext`
        const hook = `interface NitroRuntimeHooks { 'nuxt-pre-fetch:request': (context: ${context}) => void | Promise<void> }`
        return [`declare module 'nitropack/types' { ${hook} }`, `declare module 'nitropack' { ${hook} }`, 'export {}'].join('\n')
      },
    }, { nitro: true })

    addPlugin({ src: resolver.resolve('./runtime/plugins/pre-fetch.client'), mode: 'client' })
    if (options.clientNavigation) {
      addRouteMiddleware({ name: 'nuxt-pre-fetch', path: resolver.resolve('./runtime/middleware/pre-fetch'), global: true })
    }
    addServerPlugin(resolver.resolve('./runtime/server/plugins/render-html'))
    addServerHandler({ route: options.endpoint, method: 'get', handler: resolver.resolve('./runtime/server/handlers/pre-fetch') })
    if (options.learn?.enabled) {
      addServerHandler({ route: `${options.endpoint}/learn`, method: 'post', handler: resolver.resolve('./runtime/server/handlers/learn') })
    }
    // `useNuxtApp().$nuxtPreFetch`, typed for apps and libraries.
    addTypeTemplate({
      filename: 'types/nuxt-pre-fetch-app.d.ts',
      getContents: () => {
        const api = `import(${JSON.stringify(resolver.resolve('./runtime/plugins/pre-fetch.client'))}).NuxtPreFetchApi`
        return [`declare module '#app' { interface NuxtApp { $nuxtPreFetch: ${api} } }`, 'export {}'].join('\n')
      },
    })
    addServerImports([
      { name: 'runPrefetch', from: resolver.resolve('./runtime/server/utils/runner') },
      { name: 'definePrefetch', from: resolver.resolve('./runtime/server/utils/define') },
    ])

    // Dev: re-analyse an edited page, store or composable, regenerate the client route
    // list and reload Nitro. Added/removed modules may change the auto-import registry.
    if (nuxt.options.dev) {
      nuxt.hook('builder:watch', async (event, path) => {
        const absolute = resolve(nuxt.options.srcDir, path)
        if (inPrefetchDir(absolute) || inPrefetchDir(resolve(nuxt.options.rootDir, path))) {
          if (rescanDefinitions() || event !== 'change') {
            await updateTemplates({ filter: template => template.filename === 'nuxt-pre-fetch/routes.mjs' })
            await useNitro().hooks.callHook('rollup:reload')
          }
          return
        }
        // Normalised (`resolve`): Nuxt reports `C:/a/b.ts`, Node paths are `C:\a\b.ts` on Windows.
        const file = resolve(nuxt.options.srcDir, path)
        const alt = resolve(nuxt.options.rootDir, path)
        const watched = builder.watchedFiles
        const target = watched.has(file) ? file : watched.has(alt) ? alt : null
        const moduleAddedOrRemoved = (event === 'add' || event === 'unlink') && /\.[cm]?[jt]sx?$/.test(path)
        if (!target && !moduleAddedOrRemoved) return
        if (target) builder.invalidate(target)
        if (moduleAddedOrRemoved) await refreshAutoImports()
        const before = new Set(current.warnings.map(w => `${w.file}:${w.line} ${w.message}`))
        if (!rebuild()) return
        report(current.warnings.filter(w => !before.has(`${w.file}:${w.line} ${w.message}`)))
        await syncDevServer()
      })
    }
  },
})

export default module
