import { defaultAsyncDataKey, hashString, joinBaseURL, normalizeQuery, requestIdentity } from '../shared/identity'

export interface FetchOptionsLike {
  method?: unknown
  baseURL?: unknown
  query?: unknown
  params?: unknown
  body?: unknown
}

function resolve(value: unknown): unknown {
  if (typeof value === 'function') return (value as () => unknown)()
  if (value && typeof value === 'object' && '__v_isRef' in value) return (value as unknown as { value: unknown }).value
  return value
}

/**
 * Identity of a request as issued by `useFetch`, or `null` when it can never
 * have been prefetched (non-GET, body, non-string request).
 */
export function prefetchIdentity(request: unknown, options: FetchOptionsLike = {}): string | null {
  const url = resolve(request)
  if (typeof url !== 'string') return null
  const method = String(resolve(options.method) ?? 'GET').toUpperCase()
  if (method !== 'GET' || resolve(options.body) !== undefined) return null
  const baseURL = resolve(options.baseURL)
  return requestIdentity(
    method,
    joinBaseURL(typeof baseURL === 'string' ? baseURL : undefined, url),
    normalizeQuery(options.params as Record<string, unknown>, options.query as Record<string, unknown>),
  )
}

/** `useAsyncData` key for a `usePreFetch()` call without an explicit `key`. */
export function asyncDataKeyFor(request: unknown, options: FetchOptionsLike = {}): string {
  const identity = prefetchIdentity(request, options)
  if (identity) return defaultAsyncDataKey(identity)
  let body = ''
  try {
    body = JSON.stringify(resolve(options.body)) ?? ''
  }
  catch {
    body = String(resolve(options.body))
  }
  const url = resolve(request)
  return defaultAsyncDataKey(hashString(JSON.stringify([
    String(resolve(options.method) ?? 'GET').toUpperCase(),
    typeof url === 'string' ? url : '',
    resolve(options.baseURL) ?? '',
    normalizeQuery(options.params as Record<string, unknown>, options.query as Record<string, unknown>),
    body,
  ])))
}
