// Request identity shared by the Nitro runner and the browser. Both sides call
// `requestIdentity()` on the *resolved* request (final URL + final query), so a
// request the server prefetched and the same request issued by `usePreFetch()`
// in the browser always produce the same id. Headers and cookies never enter it.

export type QueryValue = string | string[]
export type NormalizedQuery = Record<string, QueryValue>

/** `<script type="application/json">` id the HTML payload is embedded under. */
export const PAYLOAD_ELEMENT_ID = '__NUXT_PRE_FETCH__'
/** Header marking a request issued by the prefetch runner (loop guard). */
export const INTERNAL_HEADER = 'x-nuxt-pre-fetch'
/** Payload format version. */
export const PAYLOAD_VERSION = 1

function stringifyScalar(value: unknown): string {
  if (value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Normalises one query value the way it ends up on the wire: `undefined` is
 * dropped, `null` becomes an empty value, arrays become repeated keys and
 * everything else is stringified.
 */
export function normalizeQueryValue(value: unknown): QueryValue | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    return value.filter(item => item !== undefined).map(stringifyScalar)
  }
  return stringifyScalar(value)
}

function unwrap(value: unknown): unknown {
  // Accept refs and getters one level deep, like `useFetch` does for query objects.
  if (typeof value === 'function') return (value as () => unknown)()
  if (value && typeof value === 'object' && '__v_isRef' in value) return (value as unknown as { value: unknown }).value
  return value
}

export function normalizeQuery(...sources: Array<Record<string, unknown> | null | undefined>): NormalizedQuery {
  const out: NormalizedQuery = {}
  for (const source of sources) {
    const resolved = unwrap(source) as Record<string, unknown> | null | undefined
    if (!resolved || typeof resolved !== 'object') continue
    for (const key of Object.keys(resolved)) {
      const value = normalizeQueryValue(unwrap(resolved[key]))
      if (value === undefined) delete out[key]
      else out[key] = value
    }
  }
  return out
}

/** Splits `/a/b?x=1#h` into path and parsed search params (hash dropped). */
export function splitURL(url: string): { path: string, query: NormalizedQuery } {
  const hashIndex = url.indexOf('#')
  const noHash = hashIndex === -1 ? url : url.slice(0, hashIndex)
  const queryIndex = noHash.indexOf('?')
  if (queryIndex === -1) return { path: noHash, query: {} }
  const query: NormalizedQuery = {}
  for (const [key, value] of new URLSearchParams(noHash.slice(queryIndex + 1))) {
    const existing = query[key]
    if (existing === undefined) query[key] = value
    else query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value]
  }
  return { path: noHash.slice(0, queryIndex), query }
}

/** Joins `baseURL` and a request path exactly like the analyzer does at build time. */
export function joinBaseURL(baseURL: string | undefined, url: string): string {
  if (!baseURL || /^[a-z][a-z\d+\-.]*:\/\//i.test(url)) return url
  return baseURL.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '')
}

// 2 × 32-bit FNV-1a with different offsets → 16 hex chars. Synchronous, tiny,
// identical in Node and browsers. Not a security primitive: ids are cache keys.
function fnv1a(input: string, seed: number): string {
  let hash = seed >>> 0
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function hashString(input: string): string {
  return fnv1a(input, 0x811C9DC5) + fnv1a(input, 0x050C5D1F)
}

/**
 * Stable id of one GET request: method + path + query (URL-embedded query
 * merged with the `query` object, keys sorted).
 */
export function requestIdentity(method: string, url: string, query: NormalizedQuery = {}): string {
  const split = splitURL(url)
  const merged: NormalizedQuery = { ...split.query, ...query }
  const entries = Object.keys(merged).sort().map(key => [key, merged[key]])
  return hashString(JSON.stringify([method.toUpperCase(), split.path, entries]))
}

/** Default `useAsyncData` key for a request without an explicit `key`. */
export function defaultAsyncDataKey(identity: string): string {
  return `pf:${identity}`
}
