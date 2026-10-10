// Pure manifest resolution (no Nitro imports) so it can be unit tested.
import type { Manifest, ManifestRequest, ManifestRoute, PrivateRuntimeOptions } from '../../shared/types'
import type { NormalizedQuery } from '../../shared/identity'
import { normalizeQueryValue, requestIdentity, splitURL } from '../../shared/identity'

export type RouteParams = Record<string, string | string[] | undefined>

export interface MatchedRoute {
  route: ManifestRoute
  params: RouteParams
}

export interface ResolvedRequest {
  /** Request identity, equal to the one the browser computes. */
  id: string
  /** URL to fetch (params percent-encoded). */
  url: string
  query: NormalizedQuery
  headers: Record<string, string>
  pick?: string[]
  /** Absolute URL to an allowed external host. */
  external: boolean
  host?: string
  source: string
}

export type ResolveResult =
  | { ok: true, request: ResolvedRequest }
  | { ok: false, reason: string, source: string }

const compiled = new WeakMap<ManifestRoute, RegExp>()

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return null
  }
}

/** First manifest route matching `pathname` (routes are pre-sorted by specificity). */
export function matchRoute(manifest: Manifest, pathname: string): MatchedRoute | null {
  for (const route of manifest.routes) {
    let re = compiled.get(route)
    if (!re) {
      re = new RegExp(route.re, 'i')
      compiled.set(route, re)
    }
    const match = re.exec(pathname)
    if (!match) continue
    const params: RouteParams = {}
    for (const [index, param] of route.params.entries()) {
      const raw = match[index + 1]
      if (raw === undefined) continue
      if (param.repeat) {
        const parts = raw.split('/').map(decode)
        if (parts.includes(null)) return null
        params[param.name] = parts as string[]
      }
      else {
        const value = decode(raw)
        if (value === null) return null
        params[param.name] = value
      }
    }
    return { route, params }
  }
  return null
}

/** Parses a raw query string the way vue-router exposes `route.query` (flags → ''). */
export function parseRequestQuery(search: string): NormalizedQuery {
  return splitURL(`?${search.replace(/^\?/, '')}`).query
}

/** `${value}` in a template literal: arrays join with `,` like JS does. */
function templateString(value: string | string[]): string {
  return Array.isArray(value) ? value.join(',') : value
}

function unsafePathValue(value: string): boolean {
  return value === '.' || value === '..' || /[/?#\\]/.test(value)
}

export function resolveRequest(
  request: ManifestRequest,
  params: RouteParams,
  routeQuery: NormalizedQuery,
  external: PrivateRuntimeOptions['external'],
  /** Current item of a list query (requests with `each`). */
  item?: string,
): ResolveResult {
  const fail = (reason: string): ResolveResult => ({ ok: false, reason, source: request.source })

  let identityURL = ''
  let fetchURL = ''
  for (const part of request.url) {
    if (typeof part === 'string') {
      identityURL += part
      fetchURL += part
      continue
    }
    const name = 'p' in part ? `route param "${part.p}"` : 'q' in part ? `query value "${part.q}"` : 'list item'
    const value = 'p' in part ? params[part.p] : 'q' in part ? routeQuery[part.q] : item
    if (value === undefined) return fail(`${name} is missing`)
    const text = templateString(value)
    if (unsafePathValue(text)) return fail(`${name} contains path or query syntax`)
    identityURL += text
    fetchURL += encodeURIComponent(text)
  }

  const query: NormalizedQuery = {}
  for (const [name, source] of Object.entries(request.query ?? {})) {
    let value: unknown
    if ('v' in source) value = source.v
    else if ('rq' in source) value = routeQuery[source.rq]
    else value = params[source.rp]
    const normalized = normalizeQueryValue(value)
    if (normalized !== undefined) query[name] = normalized
  }

  let isExternal = false
  let host: string | undefined
  if (/^https?:\/\//i.test(fetchURL)) {
    let parsed: URL
    try {
      parsed = new URL(fetchURL)
    }
    catch {
      return fail('invalid absolute URL')
    }
    host = parsed.host.toLowerCase()
    if (!external.allowedHosts.map(h => h.toLowerCase()).includes(host)) {
      return fail(`host ${host} is not in nuxtPreFetch.external.allowedHosts`)
    }
    isExternal = true
  }
  else if (!fetchURL.startsWith('/') || fetchURL.startsWith('//')) {
    return fail('URL is neither app-relative nor absolute')
  }

  return {
    ok: true,
    request: {
      id: requestIdentity('GET', identityURL, query),
      url: fetchURL,
      query,
      headers: { ...request.headers },
      pick: request.pick,
      external: isExternal,
      host,
      source: request.source,
    },
  }
}

/**
 * Items of a list query as the page sees them (`String(route.query.ids).split(',')`, with
 * the page's `.slice(0, n)` if any): empty and duplicate items dropped, then at most
 * `max` (`maxListItems`, `0` = unlimited). `null` when the
 * query is absent.
 */
export function listItems(each: { q: string, sep: string, max?: number }, routeQuery: NormalizedQuery, max: number): string[] | null {
  const raw = routeQuery[each.q]
  if (raw === undefined) return null
  const text = Array.isArray(raw) ? raw.join(',') : raw
  // The page's own `.slice(0, n)` applies to the raw split, exactly like in the browser.
  const split = text.split(each.sep)
  const items = [...new Set((each.max === undefined ? split : split.slice(0, each.max)).filter(Boolean))]
  return max > 0 ? items.slice(0, max) : items
}

/** `pick` as `useAsyncData` applies it, but only to plain objects (anything else is kept whole). */
export function pickKeys(data: unknown, keys: string[] | undefined): unknown {
  if (!keys || !data || typeof data !== 'object' || Array.isArray(data)) return data
  const picked: Record<string, unknown> = {}
  for (const key of keys) picked[key] = (data as Record<string, unknown>)[key]
  return picked
}

/** Strips `app.baseURL` from a request path; `null` when the path is outside it. */
export function withoutBase(path: string, baseURL: string): string | null {
  const base = baseURL.replace(/\/+$/, '')
  if (!base) return path
  if (path === base) return '/'
  if (path.startsWith(`${base}/`) || path.startsWith(`${base}?`)) return path.slice(base.length) || '/'
  return null
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index]!)
    }
  })
  await Promise.all(lanes)
  return results
}
