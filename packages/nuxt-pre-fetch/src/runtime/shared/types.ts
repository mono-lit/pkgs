/**
 * A URL template part: literal text, a route param / query value substituted at request
 * time, or the current item of a list query (see `ManifestRequest.each`).
 */
export type UrlPart = string | { p: string } | { q: string } | { item: true }

/** Where one query value comes from. */
export type QuerySource =
  | { v: unknown } // literal
  | { rq: string } // route.query.<name>
  | { rp: string } // route.params.<name>

/** One statically discovered `usePreFetch()` request. */
export interface ManifestRequest {
  url: UrlPart[]
  query?: Record<string, QuerySource>
  headers?: Record<string, string>
  /**
   * One request per item of a list query: `route.query.<q>` split by `sep`
   * (`String(route.query.ids ?? '').split(',').map(id => usePreFetch(...))`).
   */
  each?: {
    q: string
    sep: string
    /** `.slice(0, max)` in the page: only the first `max` raw items are ever used. */
    max?: number
  }
  /** Top-level keys kept by Nitro before embedding (literal `pick` without `transform`). */
  pick?: string[]
  /**
   * Pinia store id when the call lives in a setup store. A store sets up once per app, so on
   * client navigation Nitro skips these when the browser reports the store as active.
   */
  store?: string
  /** `pages/foo.vue:12` — used in debug logs only (server bundle). */
  source: string
}

export interface ManifestRouteParam {
  name: string
  /** `[...slug]` style params match several segments and resolve to an array. */
  repeat: boolean
}

export interface ManifestRoute {
  /** Nuxt route path, e.g. `/users/:id()`. */
  pattern: string
  /** RegExp source (flags `i`) matching a request pathname. */
  re: string
  params: ManifestRouteParam[]
  requests: ManifestRequest[]
}

export interface Manifest {
  routes: ManifestRoute[]
}

/** A prefetched result: `d` = data (may be `null`, `false`, `0`, `[]` …), `e` = HTTP error. */
export type PayloadEntry =
  | { d: unknown }
  | { e: { s: number, m?: string, d?: unknown } }

/**
 * A request that FAILED on the server (HTTP error, timeout, network, over `maxEntryBytes`): sent
 * to the browser so it stops waiting and retries the request itself. `s`: HTTP status, when
 * there was a response.
 */
export interface PayloadFailure {
  s?: number
  r: 'http' | 'timeout' | 'network' | 'size'
}

export interface PrefetchPayload {
  v: 1
  /** Route full path the payload was produced for. */
  path: string
  entries: Record<string, PayloadEntry>
  /**
   * Ids in `entries` that are RUNTIME requests (declared with `definePrefetch`, or learned):
   * served to `$nuxtPreFetch.take()` callers until consumed instead of closing with the page render.
   */
  runtime?: string[]
  /** Requests that failed on the server, by id: the browser retries them itself. */
  failed?: Record<string, PayloadFailure>
  /** Debug only: every runtime id the server planned for the page (fetched or not). */
  planned?: string[]
  /** App paths this browser has learned requests for (HTML payload only; drives client navigation). */
  paths?: string[]
}

/**
 * One runtime request: declared for a page (`definePrefetch`) or reported from the browser
 * (`$nuxtPreFetch.learn()`). Never contains a token.
 */
export interface PrefetchRequest {
  /** Absolute `http(s)://` URL to an allowed host, or an app-relative `/…` URL. May carry a query. */
  url: string
  query?: Record<string, QueryValue>
  /** Non-credential headers; filtered to `dynamic.forwardHeaders` on the server. */
  headers?: Record<string, string>
  /**
   * Send `Authorization: Bearer <cookie value>` — the cookie is read from the page request,
   * so the token is never stored. `split`: the value is chunked into `<cookie>_split_<i>` cookies.
   * Must be listed in `dynamic.authCookies`.
   */
  auth?: { cookie: string, split?: boolean }
}

/** @deprecated name of `PrefetchRequest`. */
export type LearnedRequest = PrefetchRequest

export type QueryValue = string | string[]

/** Runtime requests (`definePrefetch` and learned): where they may go and how much. */
export interface DynamicRequestOptions {
  /** Hosts (`api.example.com`, `api.example.com:8443`) absolute URLs may target. */
  allowedHosts: string[]
  /** Cookies a request may turn into `Authorization: Bearer …`. */
  authCookies: string[]
  /** Header names (lower-case) a request may carry. @default ['accept'] */
  forwardHeaders: string[]
  /** Max runtime requests per page. @default 40 */
  maxRequestsPerPage: number
  /** Responses larger than this (bytes of JSON) are not embedded. @default 2_000_000 */
  maxEntryBytes: number
}

export interface LearnOptions {
  /** Record + replay requests reported through `$nuxtPreFetch.learn()`. @default false */
  enabled: boolean
  /** Max pages remembered per browser (oldest dropped). @default 50 */
  maxPages: number
  /** How long a learned page is remembered, in seconds. @default 604800 (7 days) */
  ttl: number
}

/** What the learned-request store needs. */
export type LearnStoreOptions = LearnOptions & Pick<DynamicRequestOptions, 'maxRequestsPerPage'>

export interface PublicRuntimeOptions {
  enabled: boolean
  debug: boolean
  clientNavigation: boolean
  fetchMode: 'client' | 'server'
  fallback: 'client' | 'error'
  endpoint: string
  navigationTimeout: number
  keepPayload: boolean
  streamNavigation: boolean
  /** Learned requests are recorded and replayed. */
  learn: boolean
  /**
   * A prefetch that failed on the server: 'retry' — the browser fetches it again itself
   * (default); 'embed' — a 4xx is handed to usePreFetch as its error (no browser request).
   */
  serverErrors: 'retry' | 'embed'
}

export interface ExternalHostOptions {
  /** Hosts (`api.example.com`, `api.example.com:8443`) prefetchable from absolute URLs. */
  allowedHosts: string[]
  /** Incoming request headers forwarded per host, e.g. `{ 'api.example.com': ['authorization'] }`. */
  forwardHeaders: Record<string, string[]>
}

export interface PrivateRuntimeOptions {
  concurrency: number
  /** Max items of a list query (`each`) prefetched per request (0 = unlimited); the rest is fetched by the browser. */
  maxListItems: number
  timeout: number
  external: ExternalHostOptions
  dynamic: DynamicRequestOptions
  learn: LearnOptions
}
