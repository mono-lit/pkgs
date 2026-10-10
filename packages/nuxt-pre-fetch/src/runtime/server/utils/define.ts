// `definePrefetch(pattern, handler)`: a page's opening requests, known on the FIRST request.
//
// Files under `<srcDir>/prefetch/` declare, per route pattern, the requests a page sends when it
// opens — when they can't be discovered at build time (built at runtime from cookies/JWT claims,
// the date, …). Nitro runs the handler while it produces the page's HTML, fetches what it
// returns, and embeds the results; the page's own calls then find their answers waiting.
//
// A handler returns plain requests, or DESCRIPTORS: objects a data library creates (e.g.
// `monoFetchOdata.prefetch({...})`) that describe a call with the library's own arguments and
// emit the exact request(s) it would send. The protocol is a `Symbol.for` key, so libraries don't
// import this module.
import type { H3Event } from 'h3'
import type { PrefetchRequest } from '../../shared/types'
import type { RouteParams } from './resolve'

/** Marks a prefetch descriptor (`Symbol.for` — libraries need no import). */
export const PREFETCH_DESCRIPTOR: unique symbol = Symbol.for('nuxt-pre-fetch.descriptor') as any

/** What a handler (and a descriptor's `collect`) gets for the request being served. */
export interface PrefetchContext {
  event: H3Event
  /** App-relative full path of the page (with query). */
  path: string
  route: { path: string, query: Record<string, string | string[]>, params: RouteParams }
  /** Cookies of the page request (decoded). */
  cookies: Record<string, string>
  cookie: (name: string) => string | undefined
  headers: Record<string, string | undefined>
  /** When the page was requested. */
  now: Date
}

/** A request as handlers/descriptors give it: query values are normalized (stringified) on the server. */
export type DeclaredRequest = Omit<PrefetchRequest, 'query'> & { query?: Record<string, unknown> }

/** A call described by a data library: emits the request(s) it would send. */
export interface PrefetchDescriptor {
  readonly [PREFETCH_DESCRIPTOR]: true
  collect: (context: PrefetchContext, emit: (request: DeclaredRequest) => void) => void | Promise<void>
}

/**
 * What a handler returns. Descriptors are typed structurally (any object with `collect`): a library
 * declares its own `Symbol.for('nuxt-pre-fetch.descriptor')` key, which TypeScript sees as a different
 * symbol; the runtime check (`isPrefetchDescriptor`) is what tells them apart from plain requests.
 */
export type PrefetchItem = PrefetchDescriptor | { collect: (context: PrefetchContext, emit: (request: DeclaredRequest) => void) => void | Promise<void> } | DeclaredRequest | null | undefined | false

export type PrefetchHandler = (context: PrefetchContext) => PrefetchItem[] | Promise<PrefetchItem[]>

export interface PrefetchDefinition {
  /** Nuxt route path the page lives at, e.g. `/home`, `/users/:id()` (`:id` works too). */
  pattern: string
  handler: PrefetchHandler
}

/**
 * Declares a page's opening requests. The first argument must be a string literal: it is read
 * at build time so client navigation knows the route too.
 *
 * ```ts
 * // app/prefetch/home.ts
 * export default definePrefetch('/home', ctx => [
 *   { url: 'https://api.example.com/items', query: { $top: 10 }, auth: { cookie: 'token' } },
 *   someLibraryCall.prefetch({ ... }),
 * ])
 * ```
 */
export function definePrefetch(pattern: string, handler: PrefetchHandler): PrefetchDefinition {
  return { pattern, handler }
}

export function isPrefetchDescriptor(value: unknown): value is PrefetchDescriptor {
  return !!value && typeof value === 'object' && (value as Record<symbol, unknown>)[PREFETCH_DESCRIPTOR] === true
    && typeof (value as PrefetchDescriptor).collect === 'function'
}

/**
 * Runs a handler and every descriptor it returns; collects the emitted requests. A failing
 * descriptor only drops its own requests (that call is then fetched by the page as usual).
 */
export async function collectPrefetch(handler: PrefetchHandler, context: PrefetchContext, onError?: (error: unknown) => void): Promise<PrefetchRequest[]> {
  const requests: PrefetchRequest[] = []
  const emit = (request: DeclaredRequest) => {
    if (request && typeof request.url === 'string') requests.push(request as PrefetchRequest)
  }
  const items = await handler(context)
  await Promise.all((Array.isArray(items) ? items : []).map(async (item) => {
    if (!item) return
    try {
      if (isPrefetchDescriptor(item)) await item.collect(context, emit)
      else emit(item as DeclaredRequest)
    }
    catch (error) {
      onError?.(error)
    }
  }))
  return requests
}
