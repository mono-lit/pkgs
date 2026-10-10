// Learned requests: pure helpers (no Nitro imports) so they can be unit tested.
//
// A library running in the browser (e.g. a data layer whose URLs are built at runtime)
// reports the GET requests a page sent (`$nuxtPreFetch.learn()`). Nitro remembers them
// per browser + page and replays them on the next visit of that page, while it produces
// the HTML. Only REQUESTS are remembered, never data or tokens: every replay is a fresh
// fetch with the credentials of the request being served.
import type { DynamicRequestOptions, LearnedRequest, QueryValue } from '../../shared/types'
import { hashString, normalizeQuery, requestIdentity } from '../../shared/identity'

/** Cookie holding this browser's anonymous id (scopes what it has learned). */
export const BROWSER_COOKIE = 'npf_id'

/** What Nitro stores for one page of one browser. */
export interface LearnedPage {
  /** Id of the visit the requests come from: a new visit replaces the set. */
  visit: string
  /** Last write, epoch ms. */
  at: number
  requests: LearnedRequest[]
}

/** Index of the pages one browser has learned: path → last write (epoch ms). */
export type LearnedIndex = Record<string, number>

export type LearnRejection = { ok: false, reason: string }

const MAX_URL_LENGTH = 8192
const MAX_HEADER_VALUE = 1024
const ID_RE = /^[\da-f]{32}$/
const VISIT_RE = /^[\w-]{1,64}$/

export function isBrowserId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

export function newBrowserId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Storage keys (path hashed: keys stay short and free of separators). */
export function pageKey(browserId: string, path: string): string {
  return `learned:${browserId}:page:${hashString(path)}`
}
export function indexKey(browserId: string): string {
  return `learned:${browserId}:index`
}

/** App path without hash; must be app-relative. `null` when unusable. */
export function normalizeLearnPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 2048) return null
  const hash = path.indexOf('#')
  return hash === -1 ? path : path.slice(0, hash)
}

function cleanQuery(query: unknown): Record<string, QueryValue> | null {
  if (query === undefined || query === null) return {}
  if (typeof query !== 'object' || Array.isArray(query)) return null
  return normalizeQuery(query as Record<string, unknown>)
}

/**
 * Validates one reported request against the options. Returns the sanitised request or a
 * reason. A relative URL is app-relative (served through `event.$fetch`).
 */
export function sanitizeLearnedRequest(input: unknown, options: Pick<DynamicRequestOptions, 'allowedHosts' | 'authCookies' | 'forwardHeaders'>): { ok: true, request: LearnedRequest, host?: string } | LearnRejection {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'not an object' }
  const raw = input as Record<string, unknown>
  const url = raw.url
  if (typeof url !== 'string' || !url || url.length > MAX_URL_LENGTH) return { ok: false, reason: 'invalid url' }

  let host: string | undefined
  if (/^https?:\/\//i.test(url)) {
    let parsed: URL
    try {
      parsed = new URL(url)
    }
    catch {
      return { ok: false, reason: 'invalid url' }
    }
    if (parsed.username || parsed.password) return { ok: false, reason: 'credentials in url' }
    host = parsed.host.toLowerCase()
    if (!options.allowedHosts.map(h => h.toLowerCase()).includes(host)) return { ok: false, reason: `host ${host} is not allowed` }
  }
  else if (!url.startsWith('/') || url.startsWith('//')) {
    return { ok: false, reason: 'url must be absolute http(s) or app-relative' }
  }

  const query = cleanQuery(raw.query)
  if (!query) return { ok: false, reason: 'invalid query' }

  const headers: Record<string, string> = {}
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    const allowed = new Set(options.forwardHeaders.map(h => h.toLowerCase()))
    for (const [name, value] of Object.entries(raw.headers as Record<string, unknown>)) {
      const lower = name.toLowerCase()
      if (!allowed.has(lower) || typeof value !== 'string' || value.length > MAX_HEADER_VALUE) continue
      headers[lower] = value
    }
  }

  let auth: LearnedRequest['auth']
  if (raw.auth !== undefined && raw.auth !== null) {
    const a = raw.auth as { cookie?: unknown, split?: unknown }
    if (typeof a.cookie !== 'string' || !options.authCookies.includes(a.cookie)) return { ok: false, reason: 'auth cookie is not allowed' }
    auth = a.split === true ? { cookie: a.cookie, split: true } : { cookie: a.cookie }
  }

  const request: LearnedRequest = { url }
  if (Object.keys(query).length) request.query = query
  if (Object.keys(headers).length) request.headers = headers
  if (auth) request.auth = auth
  return { ok: true, request, host }
}

/** Identity of a learned request: the same one the browser computes for it. */
export function learnedRequestId(request: LearnedRequest): string {
  return requestIdentity('GET', request.url, request.query ?? {})
}

/**
 * Merges a reported batch into the stored page: the same visit appends (deduped by id),
 * a new visit replaces — the set is always what the LAST visit sent.
 */
export function mergeLearnedPage(previous: LearnedPage | null, visit: string, requests: LearnedRequest[], max: number, now: number): LearnedPage {
  const base = previous && previous.visit === visit ? previous.requests : []
  const byId = new Map<string, LearnedRequest>()
  for (const request of [...base, ...requests]) {
    const id = learnedRequestId(request)
    if (!byId.has(id)) byId.set(id, request)
  }
  return { visit, at: now, requests: [...byId.values()].slice(0, Math.max(0, max)) }
}

/** Records `path` in the index and drops the oldest pages beyond `maxPages`; returns the dropped paths. */
export function touchIndex(index: LearnedIndex, path: string, now: number, maxPages: number, ttlMs: number): string[] {
  index[path] = now
  const dropped: string[] = []
  for (const [key, at] of Object.entries(index)) {
    if (now - at > ttlMs) {
      delete index[key]
      dropped.push(key)
    }
  }
  const ordered = Object.entries(index).sort((a, b) => b[1] - a[1])
  for (const [key] of ordered.slice(Math.max(0, maxPages))) {
    delete index[key]
    dropped.push(key)
  }
  return dropped
}

/** Live paths of an index (TTL applied). */
export function indexPaths(index: LearnedIndex | null, now: number, ttlMs: number): string[] {
  if (!index) return []
  return Object.entries(index).filter(([, at]) => now - at <= ttlMs).map(([path]) => path)
}

export function isVisitId(value: unknown): value is string {
  return typeof value === 'string' && VISIT_RE.test(value)
}

/**
 * Bearer token for a learned request, read from the page request's cookies (never stored).
 * `split`: the value is chunked into `<cookie>_split_0`, `_1`, … (joined in index order);
 * falls back to the plain cookie.
 */
export function readAuthToken(cookies: Record<string, string>, auth: LearnedRequest['auth']): string | undefined {
  if (!auth) return undefined
  if (auth.split) {
    const prefix = `${auth.cookie}_split_`
    const chunks = Object.keys(cookies)
      .filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
      .map(name => cookies[name]!)
    if (chunks.length) return chunks.join('')
  }
  return cookies[auth.cookie] || undefined
}
