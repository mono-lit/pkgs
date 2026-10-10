import type { H3Event } from 'h3'
import { getRequestHeaders, getRequestHeader, parseCookies } from 'h3'
import { useNitroApp, useRuntimeConfig } from 'nitropack/runtime'
import { manifest } from '#nuxt-pre-fetch/manifest'
import { definitions } from '#nuxt-pre-fetch/definitions'
import type { Manifest, PayloadEntry, PayloadFailure, PrefetchRequest, PrefetchPayload, PrivateRuntimeOptions, PublicRuntimeOptions } from '../../shared/types'
import { INTERNAL_HEADER, PAYLOAD_VERSION, splitURL } from '../../shared/identity'
import type { ResolvedRequest } from './resolve'
import { listItems, mapWithConcurrency, matchRoute, parseRequestQuery, pickKeys, resolveRequest } from './resolve'
import { learnedRequestId, readAuthToken, sanitizeLearnedRequest } from './learned'
import { getBrowserId, readLearnedPage } from './learned-store'
import type { PrefetchContext, PrefetchDefinition } from './define'
import { collectPrefetch } from './define'

export interface RunPrefetchOptions {
  /** Only run the request with this identity (used by `fetchMode: 'server'` refreshes). */
  only?: string
  /**
   * Pinia stores already active in the browser: their setup (and its `usePreFetch` calls)
   * will not run again, so their requests are skipped.
   */
  skipStores?: string[]
  /**
   * Called with each result the moment its request settles (in completion order), before
   * the others finish: the streaming endpoint sends it to the browser right away.
   */
  onEntry?: (id: string, entry: PayloadEntry) => void
  /** Called with each request that failed on the server (the browser retries it). */
  onFailure?: (id: string, failure: PayloadFailure) => void
}

/** Context of the `nuxt-pre-fetch:request` Nitro runtime hook. */
export interface PreFetchRequestContext {
  event: H3Event
  /** App-relative route full path being prefetched. */
  path: string
  request: ResolvedRequest
  /** Set to `true` to skip this request (the browser then fetches it itself). */
  skip: boolean
}

/** What one prefetch run will fetch, decided before anything is fetched. */
export interface PrefetchPlan {
  path: string
  /** Manifest (statically discovered) requests. */
  requests: ResolvedRequest[]
  /**
   * Runtime requests: declared for the page (`definePrefetch`) and/or reported by this browser
   * on an earlier visit (learned).
   */
  runtime: Array<{ id: string, request: PrefetchRequest, external: boolean, source: 'declared' | 'learned' }>
}

/**
 * Body of a local API error as the browser would have received it, minus the
 * fields that describe the server (`url`, `stack`). External error bodies are
 * never embedded.
 */
function errorBody(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const { url: _url, stack: _stack, ...rest } = data as Record<string, unknown>
  return rest
}

/** `Server-Timing` header value for a prefetch run. */
export function serverTiming(durationMs: number, requests: number): string {
  return `nuxt-pre-fetch;dur=${durationMs.toFixed(1)};desc="usePreFetch (${requests})"`
}

type FetchFn = (url: string, init: Record<string, unknown>) => Promise<unknown>

function errorStatus(error: unknown): number | undefined {
  const value = error as { statusCode?: number, status?: number, response?: { status?: number } } | null
  return value?.statusCode ?? value?.status ?? value?.response?.status
}

type Config = { nuxtPreFetch: PrivateRuntimeOptions, public: { nuxtPreFetch: PublicRuntimeOptions } }

function learningOn(config: Config): boolean {
  return !!config.public.nuxtPreFetch?.learn && !!config.nuxtPreFetch.learn?.enabled
}

/** Whether `path` (app-relative) is a route with prefetchable requests at all. */
export function isPrefetchRoute(event: H3Event, path: string): boolean {
  const config = useRuntimeConfig(event) as unknown as { public: { nuxtPreFetch?: PublicRuntimeOptions } }
  return !!config.public.nuxtPreFetch?.enabled && !!matchRoute(manifest, splitURL(path).path)
}

/**
 * Decides what a prefetch of `path` (app-relative, may include a query string) runs: the
 * matching manifest route's requests plus this browser's learned requests for the page.
 * `null` when there is nothing to run for it at all.
 */
export async function planPrefetch(event: H3Event, path: string, options: RunPrefetchOptions = {}): Promise<PrefetchPlan | null> {
  const config = useRuntimeConfig(event) as unknown as Config
  const privateOptions = config.nuxtPreFetch
  const publicOptions = config.public.nuxtPreFetch
  if (!publicOptions?.enabled) return null

  const requests = new Map<string, ResolvedRequest>()
  const matched = matchRoute(manifest, splitURL(path).path)
  if (matched) {
    const search = path.includes('?') ? path.slice(path.indexOf('?') + 1).split('#')[0]! : ''
    const routeQuery = parseRequestQuery(search)
    const nitroApp = useNitroApp()
    // List-query requests (`each`) expand into one request per item, capped by maxListItems.
    const expanded = matched.route.requests.flatMap((manifestRequest) => {
      if (!manifestRequest.each) return [{ manifestRequest, item: undefined as string | undefined }]
      const items = listItems(manifestRequest.each, routeQuery, privateOptions.maxListItems) ?? []
      return items.map(item => ({ manifestRequest, item }))
    })

    for (const { manifestRequest, item } of expanded) {
      if (manifestRequest.store && options.skipStores?.includes(manifestRequest.store)) continue
      const resolved = resolveRequest(manifestRequest, matched.params, routeQuery, privateOptions.external, item)
      if (!resolved.ok) {
        if (publicOptions.debug) console.debug(`[nuxt-pre-fetch] skip ${resolved.source}: ${resolved.reason}`)
        continue
      }
      if (options.only && resolved.request.id !== options.only) continue
      const existing = requests.get(resolved.request.id)
      if (existing) {
        // Same request declared twice: run once, keep every key either call picks.
        existing.pick = existing.pick && resolved.request.pick ? [...new Set([...existing.pick, ...resolved.request.pick])] : undefined
        continue
      }
      const context: PreFetchRequestContext = { event, path, request: resolved.request, skip: false }
      await nitroApp.hooks.callHook('nuxt-pre-fetch:request' as any, context)
      if (!context.skip) requests.set(resolved.request.id, context.request)
    }
  }

  const runtime: PrefetchPlan['runtime'] = []
  const addRuntime = (input: PrefetchRequest, source: 'declared' | 'learned') => {
    if (runtime.length >= privateOptions.dynamic.maxRequestsPerPage) return
    // Validated every time (declared code and stored requests alike): allowed hosts, headers, auth cookies.
    const checked = sanitizeLearnedRequest(input, privateOptions.dynamic)
    if (!checked.ok) {
      if (publicOptions.debug) console.debug(`[nuxt-pre-fetch] ${source} request skipped (${checked.reason}): ${input?.url}`)
      return
    }
    const id = learnedRequestId(checked.request)
    if (requests.has(id) || runtime.some(r => r.id === id)) return
    runtime.push({ id, request: checked.request, external: !!checked.host, source })
  }

  const declared = options.only ? [] : matchDefinitions(path)
  for (const { definition, params } of declared) {
    for (const request of await runDefinition(event, path, definition, params, privateOptions.timeout, publicOptions.debug)) addRuntime(request, 'declared')
  }

  const browserId = !options.only && learningOn(config) ? getBrowserId(event) : undefined
  if (browserId) {
    const page = await readLearnedPage(browserId, path.split('#')[0]!, { ...privateOptions.dynamic, ...privateOptions.learn })
    for (const stored of page?.requests ?? []) addRuntime(stored, 'learned')
  }

  if (!matched && !declared.length && !runtime.length) return null
  return { path, requests: [...requests.values()], runtime }
}

/**
 * Runs a plan and returns the results keyed by request identity.
 *
 * - App-relative URLs go through `event.$fetch`: no HTTP hop, the incoming
 *   request's cookies/authorization are applied, so the API authorises the
 *   prefetch exactly like the browser request it replaces.
 * - Absolute URLs only run for `external.allowedHosts` (manifest) or `dynamic.allowedHosts`
 *   (runtime), with only the allowed headers. A runtime request's token is read from the
 *   page request's cookie it names.
 * - A request that FAILS here (HTTP error, timeout, network, over `maxEntryBytes`) is reported
 *   in `payload.failed` — the browser then retries it itself. With `serverErrors: 'embed'`,
 *   a manifest request's 4xx is embedded as its error instead (the browser would get the same).
 */
export async function executePrefetch(event: H3Event, plan: PrefetchPlan, options: RunPrefetchOptions = {}): Promise<PrefetchPayload> {
  const startedAt = Date.now()
  const config = useRuntimeConfig(event) as unknown as Config
  const privateOptions = config.nuxtPreFetch
  const publicOptions = config.public.nuxtPreFetch
  const embedErrors = publicOptions.serverErrors === 'embed'

  const eventFetch = (event as H3Event & { $fetch?: FetchFn }).$fetch
  const globalFetch = globalThis.$fetch as unknown as FetchFn

  type Outcome = { entry?: PayloadEntry, failure?: PayloadFailure }
  const failureOf = (error: unknown, label: string): Outcome => {
    const status = errorStatus(error)
    const timedOut = (error as { name?: string, cause?: { name?: string } } | null)?.name === 'TimeoutError'
      || (error as { cause?: { name?: string } } | null)?.cause?.name === 'TimeoutError'
    const failure: PayloadFailure = status ? { s: status, r: 'http' } : { r: timedOut ? 'timeout' : 'network' }
    if (publicOptions.debug) console.debug(`[nuxt-pre-fetch] ${label} failed on the server (${failure.s ?? failure.r}); the browser retries it`)
    return { failure }
  }

  const fetchOne = async (request: ResolvedRequest): Promise<Outcome> => {
    const signal = AbortSignal.timeout(privateOptions.timeout)
    try {
      let data: unknown
      if (request.external) {
        const forwarded: Record<string, string> = {}
        for (const name of privateOptions.external.forwardHeaders[request.host!] ?? []) {
          const value = getRequestHeader(event, name.toLowerCase())
          if (value) forwarded[name.toLowerCase()] = value
        }
        data = await globalFetch(request.url, { query: request.query, headers: { ...request.headers, ...forwarded }, signal, retry: 0 })
      }
      else {
        if (!eventFetch) throw new Error('event.$fetch is unavailable in this Nitro runtime')
        data = await eventFetch(request.url, { query: request.query, headers: { ...request.headers, [INTERNAL_HEADER]: '1' }, signal, retry: 0 })
      }
      return { entry: { d: pickKeys(data, request.pick) } }
    }
    catch (error) {
      const status = errorStatus(error)
      if (embedErrors && status && status >= 400 && status < 500) {
        const fetchError = error as { statusMessage?: string, statusText?: string, data?: unknown }
        return { entry: { e: { s: status, m: fetchError.statusMessage ?? fetchError.statusText, d: request.external ? undefined : errorBody(fetchError.data) } } }
      }
      return failureOf(error, request.source)
    }
  }

  const cookies = plan.runtime.some(r => r.request.auth) ? parseCookies(event) : {}
  const fetchRuntime = async ({ request, external, source }: PrefetchPlan['runtime'][number]): Promise<Outcome> => {
    const signal = AbortSignal.timeout(privateOptions.timeout)
    const headers: Record<string, string> = { ...request.headers }
    const token = readAuthToken(cookies, request.auth)
    if (token) headers.authorization = `Bearer ${token}`
    try {
      let data: unknown
      if (external) {
        data = await globalFetch(request.url, { query: request.query, headers, signal, retry: 0 })
      }
      else {
        if (!eventFetch) throw new Error('event.$fetch is unavailable in this Nitro runtime')
        data = await eventFetch(request.url, { query: request.query, headers: { ...headers, [INTERNAL_HEADER]: '1' }, signal, retry: 0 })
      }
      const size = typeof data === 'string' ? data.length : JSON.stringify(data ?? null).length
      if (size > privateOptions.dynamic.maxEntryBytes) {
        if (publicOptions.debug) console.debug(`[nuxt-pre-fetch] ${source} ${request.url}: ${size} bytes, over maxEntryBytes; the browser retries it`)
        return { failure: { r: 'size' } }
      }
      return { entry: { d: data } }
    }
    catch (error) {
      return failureOf(error, `${source} ${request.url}`)
    }
  }

  type Job = { id: string, run: () => Promise<Outcome> }
  const jobs: Job[] = [
    ...plan.requests.map(request => ({ id: request.id, run: () => fetchOne(request) })),
    ...plan.runtime.map(item => ({ id: item.id, run: () => fetchRuntime(item) })),
  ]
  const results = await mapWithConcurrency(jobs, privateOptions.concurrency, async (job) => {
    const outcome = await job.run()
    if (outcome.entry) options.onEntry?.(job.id, outcome.entry)
    else if (outcome.failure) options.onFailure?.(job.id, outcome.failure)
    return [job.id, outcome] as const
  })

  const entries: Record<string, PayloadEntry> = {}
  const failed: Record<string, PayloadFailure> = {}
  for (const [id, outcome] of results) {
    if (outcome.entry) entries[id] = outcome.entry
    else if (outcome.failure) failed[id] = outcome.failure
  }
  const runtimeIds = plan.runtime.map(r => r.id).filter(id => id in entries)

  if (publicOptions.debug) {
    console.debug(`[nuxt-pre-fetch] ${plan.path}: ${Object.keys(entries).length}/${jobs.length} requests (${plan.runtime.length} runtime, ${Object.keys(failed).length} failed) in ${Date.now() - startedAt}ms`)
  }
  const payload: PrefetchPayload = { v: PAYLOAD_VERSION, path: plan.path, entries }
  if (runtimeIds.length) payload.runtime = runtimeIds
  if (Object.keys(failed).length) payload.failed = failed
  // debug: every runtime id the server planned (fetched or not), so the browser can tell which of
  // its requests a definePrefetch predicted even when a fetch failed (e.g. 401 without a session).
  if (publicOptions.debug && plan.runtime.length) payload.planned = plan.runtime.map(r => r.id)
  return payload
}

/**
 * Runs the statically discovered requests of the route at `path` (app-relative,
 * may include a query string) plus this browser's learned requests for it, and returns
 * their results keyed by request identity. Returns `null` when there is nothing to run.
 */
export async function runPrefetch(event: H3Event, path: string, options: RunPrefetchOptions = {}): Promise<PrefetchPayload | null> {
  const plan = await planPrefetch(event, path, options)
  return plan ? executePrefetch(event, plan, options) : null
}

type DefinitionEntry = { pattern: string, re: string, params: Manifest['routes'][number]['params'], definition: PrefetchDefinition }

/** Every `definePrefetch` whose pattern matches `path` (several may). */
function matchDefinitions(path: string): Array<{ definition: PrefetchDefinition, params: Record<string, string | string[] | undefined> }> {
  const pathname = splitURL(path).path
  const out: Array<{ definition: PrefetchDefinition, params: Record<string, string | string[] | undefined> }> = []
  for (const entry of definitions as DefinitionEntry[]) {
    if (!entry?.definition?.handler) continue
    const matched = matchRoute({ routes: [{ pattern: entry.pattern, re: entry.re, params: entry.params, requests: [] }] }, pathname)
    if (matched) out.push({ definition: entry.definition, params: matched.params })
  }
  return out
}

/** Runs one definition for this request (bounded by `timeout`); failures only cost its requests. */
async function runDefinition(event: H3Event, path: string, definition: PrefetchDefinition, params: Record<string, string | string[] | undefined>, timeout: number, debug: boolean): Promise<PrefetchRequest[]> {
  const cookies = parseCookies(event)
  const search = path.includes('?') ? path.slice(path.indexOf('?') + 1).split('#')[0]! : ''
  const context: PrefetchContext = {
    event,
    path,
    route: { path: splitURL(path).path, query: parseRequestQuery(search), params },
    cookies,
    cookie: name => cookies[name],
    headers: getRequestHeaders(event),
    now: new Date(),
  }
  const onError = (error: unknown) => {
    if (debug) console.debug(`[nuxt-pre-fetch] definePrefetch('${definition.pattern}') call failed:`, (error as Error)?.message ?? error)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      collectPrefetch(definition.handler, context, onError),
      new Promise<PrefetchRequest[]>((resolve) => {
        timer = setTimeout(() => {
          if (debug) console.debug(`[nuxt-pre-fetch] definePrefetch('${definition.pattern}') timed out`)
          resolve([])
        }, timeout)
      }),
    ])
  }
  catch (error) {
    onError(error)
    return []
  }
  finally {
    clearTimeout(timer)
  }
}
