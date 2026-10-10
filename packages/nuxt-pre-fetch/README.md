# @mono-lit/nuxt-pre-fetch

Server-side API prefetching for Nuxt apps that run with **`ssr: false`**, without
server-rendering a single Vue component.

`usePreFetch()` is `useFetch()` with the same options, return value and types. On a
direct page load, Nitro has already called your API and put the result into the HTML
shell as `application/json`. On client navigation, Nitro fetches the destination's data
before the page renders. Either way, the page makes no initial request of its own.

```sh
pnpm add @mono-lit/nuxt-pre-fetch
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  ssr: false,
  modules: ['@mono-lit/nuxt-pre-fetch'],
})
```

```vue
<script setup lang="ts">
interface User {
  id: number
  name: string
}

const { data: users, pending, error, refresh } = await usePreFetch<User[]>('/api/users', {
  key: 'users',
  default: () => [],
})
</script>

<template>
  <button @click="refresh()">Refresh</button>
  <p v-if="pending">Loading...</p>
  <p v-else-if="error">Failed to load users</p>
  <div v-for="user in users" v-else :key="user.id">{{ user.name }}</div>
</template>
```

You don't need a route registry, Nitro hooks, server plugins, or per-page endpoints.

## How it works

```
BUILD   pages/**/*.vue ──AST (oxc)──▶ manifest: route pattern → [GET requests]
                                        (server bundle only)

GET /dashboard            Nitro render:html ─▶ runPrefetch(event, '/dashboard')
(document request)          ─▶ event.$fetch('/api/users'), … (concurrently, with the user's cookies)
                            ─▶ <script type="application/json" id="__NUXT_PRE_FETCH__">…</script>

Browser                   client plugin (enforce: 'pre') parses the JSON once into a store
                          usePreFetch() → useFetch(…, { $fetch: store-aware }) → data, no request

<NuxtLink to="/users/2">  global route middleware ─▶ GET /__nuxt_pre_fetch?path=/users/2
                            ─▶ same runPrefetch() ─▶ store ─▶ page renders with data
```

- **Vue stays fully client-rendered.** `ssr: false` stays on. Nuxt still renders the
  SPA shell per request through its Nitro renderer, which calls `render:html`; the module
  hooks in there.
- **Request discovery happens at build time.** Page components never run on the server.
  Each page's `<script setup>` is parsed into an AST with oxc and nothing in it is
  executed. In dev, editing a page regenerates the manifest and reloads Nitro.
- **The returned refs are native.** `usePreFetch` passes its own `$fetch` to `useFetch`.
  The first time each composable issues a request that was prefetched, that `$fetch`
  returns the prefetched value; `transform`, `pick` and `default` still apply, and
  `null`, `false`, `0` and `[]` are real data. Everything else goes through the network.
  `data`, `pending`, `status`, `error`, `refresh`, `execute` and `clear` all come from
  `useAsyncData`.

## What is prefetched

Only calls that run unconditionally while a page sets up: top-level statements of a
**page's** `<script setup>` (including parent pages of nested routes), and of the **Pinia
setup stores and composables** the page calls there (see
[Pinia stores and composables](#pinia-stores-and-composables)).

| Part | Supported statically |
| --- | --- |
| URL | `'/api/users'`, `` `/api/users/${route.params.id}` ``, `` `/api/pokemon/${route.query.id}` ``, `() => \`…\``, `'https://host/…'` (see `external`) |
| `query` / `params` | object literal of literals (strings, numbers, booleans, null, arrays), `route.query.x`, `route.params.x`, `computed(() => route.query.x)`, or the whole object as `computed(() => ({ … }))` / `() => ({ … })` |
| `method` | `'GET'` only |
| `baseURL` | string literal |
| `headers` | object literal of string literals |
| `pick` | string-array literal without `transform`: Nitro also applies it before embedding, so only those keys reach the HTML. The browser re-applies the same `pick`, which changes nothing. With `transform`, or a non-literal `pick`, the full response is embedded |
| `server: false` | the call is skipped |
| `key`, `default`, `transform`, `pick`, `lazy`, `immediate`, `deep`, `dedupe`, `watch`, `timeout`, `getCachedData`, `onRequest*`/`onResponse*`, … | allowed. These options are client-only and don't change what is fetched. |

Here `route` is `const route = useRoute()`, or `useRoute()` inline.

**Lists from the URL.** A comma-separated (or any literal separator) query value can drive
one request per item. This exact shape is recognised:

```ts
// /team?ids=25,6,150 → 3 Pokémon + 3 species requests, all prefetched by Nitro
const route = useRoute()
const team = String(route.query.ids ?? '').split(',').map(id => ({
  pokemon: usePreFetch<Pokemon>(() => `https://pokeapi.co/api/v2/pokemon/${id}`),
  species: usePreFetch<PokemonSpecies>(() => `https://pokeapi.co/api/v2/pokemon-species/${id}`),
}))
```

The source may be written as `route.query.ids`, `route.query.ids as string`,
`String(…)`, `(… ?? '')` or `(… || '')`. A literal `.slice(0, n)` between `split` and `map`
(`….split(',').slice(0, 250).map(…)`) caps the list in the page *and* on the server: Nitro
applies the same slice to the raw items, so a longer `?ids=` in the URL can't raise it. The callback may interpolate its item into the
URL. Nitro expands it per item, dropping empty and duplicate items. At most `maxListItems`
items (default 20) are prefetched; the rest are fetched by the browser. `0` removes the
cap, but then any visitor can make your server fire as many requests as they put in the
URL.

Calls the analyzer can't prefetch still work. The browser fetches them, exactly as
`useFetch` would, and the build prints a warning with `file:line` and the reason:

- URLs built from variables or computed values
- options built with spreads or variables
- non-GET requests, or requests with a `body`
- a custom `$fetch`
- calls inside functions, branches or loops (including Pinia actions)
- calls in layouts, components, or a non-setup `<script>`
- stores and composables a page doesn't call at the top level of its setup (for example
  only from a child component)

## Pinia stores and composables

`usePreFetch()` can live in a Pinia **setup store** or a composable. The page only calls
the store or composable, and the build follows that call into its file:

```ts
// stores/users.ts
export const useUsersStore = defineStore('users', () => {
  const { data: users } = usePreFetch<User[]>('/api/users')
  return { users }
})
```

```vue
<!-- pages/users.vue: no usePreFetch here, still prefetched -->
<script setup lang="ts">
const store = useUsersStore()
</script>
```

- **Followed calls:** top-level `use*()` calls in the page's `<script setup>`, like
  `useUsersStore()` and `storeToRefs(useUsersStore())`. They are resolved through explicit
  imports (aliases such as `~` work) or Nuxt auto-imports, including `@pinia/nuxt`'s
  `stores/`. Stores and composables that call other stores or composables are followed
  too, with a depth limit and cycle protection. Only your own source files are read, never
  `node_modules`.
- **What gets analysed:** the setup function of `defineStore('id', () => { … })`, plus
  exported or local functions and `const fn = () => …`. Option stores
  (`defineStore('id', { actions })`) are not: actions run later, not at setup.
- **Pinia runs a store's setup once per app.** On client navigation the browser sends the
  ids of stores that are already active (`skipStores`), and Nitro skips their requests:
  that data would never be read, because the store keeps the state it already has.
- **Inside a store, call `usePreFetch` without `await`.** Pinia setup functions are
  synchronous. Data, status and error are refs, as usual.
- In dev, editing a store or composable updates the manifest like editing a page.

## Request identity and keys

Each request has an id: a hash of `method + resolved path + sorted query`, including any
query string embedded in the URL. The server computes it from the manifest and the
current route, and the browser computes it from the actual request, using the same
function. Headers and cookies never enter the id. With no `key`, the `useAsyncData` key
is `pf:<id>`, so `?status=active` and `?status=inactive` are different entries. An
explicit `key` behaves like it does in `useFetch`: calls with the same key share state.

## Fetch policy

| Situation | What happens |
| --- | --- |
| Direct load or browser reload | Nitro runs the route's requests during `render:html` and the browser reuses the result |
| `<NuxtLink>` / router navigation | Middleware calls `GET /__nuxt_pre_fetch?path=…&stream=1`. Nitro sends each result as an NDJSON line the moment its request finishes. The navigation waits only until the stream **starts**, and each `usePreFetch` waits for its own result, so the page renders progressively instead of after the slowest request. With `streamNavigation: false`, it gets one JSON response with every result and waits up to `navigationTimeout` for it |
| Same-page query change (with a reactive `query`) | Prefetched through the endpoint as well |
| `refresh()` / `execute()` / watch | `fetchMode: 'client'` (default): from the browser, like `useFetch`. `fetchMode: 'server'`: `GET /__nuxt_pre_fetch?path=…&id=…`, so Nitro runs that one manifest request |
| Request not in the manifest | Browser fetch. In `fetchMode: 'server'` with `fallback: 'error'`, it fails with a 501 instead, so the backend is never called from the browser |
| A prefetch fails on the server (4xx/5xx, timeout, network, over `maxEntryBytes`) | Reported to the browser as a failure (`payload.failed` / a `{ id, failed }` stream line). Whatever waits for that result stops waiting immediately and **retries the request from the browser**, with the page's own error handling (e.g. a token refresh on 401). With `serverErrors: 'embed'`, a `usePreFetch` 4xx is embedded and surfaced in `error` instead (no browser request) |

Prefetched entries are used only while the page is setting up. They're dropped once the
page has rendered (`page:loading:end`), so a later `refresh()`, watcher or remount never
reads stale prefetched data.

## Options

```ts
export default defineNuxtConfig({
  ssr: false,
  modules: ['@mono-lit/nuxt-pre-fetch'],
  nuxtPreFetch: {
    enabled: true,
    debug: false, // log hits/misses/durations (server + browser)
    clientNavigation: true, // prefetch on router navigation
    fetchMode: 'client', // 'server': refresh()/watch run on Nitro
    fallback: 'client', // 'error': never fetch unknown requests from the browser in server mode
    concurrency: 6, // parallel requests per page prefetch
    maxListItems: 20, // items of a `?ids=a,b,c` list prefetched per call (0 = unlimited)
    timeout: 5000, // per-request server timeout (ms); slower ones are left to the browser
    navigationTimeout: 3000, // max wait before a navigation renders (ms)
    endpoint: '/__nuxt_pre_fetch',
    keepPayload: false, // true: leave the <script id="__NUXT_PRE_FETCH__"> element in the DOM after it is read
    streamNavigation: true, // client navigation: stream results as they finish (false: all at once)
    external: {
      allowedHosts: [], // e.g. ['api.example.com']
      forwardHeaders: {}, // e.g. { 'api.example.com': ['authorization'] }
    },
    prefetchDir: 'prefetch', // <srcDir>/prefetch: definePrefetch() files (see "Runtime requests"); also an array (other modules may append)
    serverErrors: 'retry', // a prefetch that fails on the server is retried by the browser ('embed': usePreFetch 4xx embedded as the error)
    dynamic: { // rules for runtime requests (definePrefetch and learned)
      allowedHosts: [], // hosts absolute URLs may target
      authCookies: [], // cookies a request may turn into a Bearer token
      forwardHeaders: ['accept'],
      maxRequestsPerPage: 40,
      maxEntryBytes: 2_000_000, // larger responses are left to the browser
    },
    learn: { // see "Learned requests"
      enabled: false,
      maxPages: 50, // per browser, oldest dropped
      ttl: 604800, // seconds a learned page is remembered
    },
  },
})
```

Everything except `external` is also available at runtime as
`runtimeConfig.public.nuxtPreFetch` (env: `NUXT_PUBLIC_NUXT_PRE_FETCH_FETCH_MODE=server`,
…). `concurrency`, `maxListItems`, `timeout`, `external`, `dynamic` and `learn` (except whether it
is on) are private (`runtimeConfig.nuxtPreFetch`).

## Runtime requests: `definePrefetch()`

The analyzer only sees requests written in a page's setup. When a page builds its requests at
runtime — filters from a JWT, the current date, user preferences, calls fired from `onMounted` —
declare the page's **opening** requests in a file under `<srcDir>/prefetch/`. Nitro runs it on
the page's **first** request, fetches what it returns with the visitor's credentials, and embeds
the results; the page's own calls then find their answers waiting.

```ts
// app/prefetch/home.ts
export default definePrefetch('/home', ctx => [
  // a plain request…
  { url: 'https://api.example.com/items', query: { year: String(ctx.now.getFullYear()) }, auth: { cookie: 'app_token' } },
  // …or a DESCRIPTOR from a data library (same arguments as the call the page makes):
  monoFetchOdata.prefetch({ configBaseUrl: 'api', url: '/Items', type: 'data', options: { … } }),
])
```

- **The pattern** (first argument) must be a string literal (`/home`, `/users/:id`): it is read at
  build time, so client navigation prefetches the route too.
- **`ctx`**: `{ event, path, route: { path, query, params }, cookies, cookie(name), headers, now }`.
- **Descriptors** are objects with `[Symbol.for('nuxt-pre-fetch.descriptor')]: true` and
  `collect(ctx, emit)` — a library builds the exact request its call sends and `emit`s it, so the
  page never re-implements URLs (`@mono-lit/utility`'s `monoFetch.prefetch`,
  `monoFetchOdata.prefetch`, `monoCreateFetcher(...).prefetch`, which run `@mono-lit/data`'s own
  OData serializer in capture mode).
- **The page side**: libraries ask `useNuxtApp().$nuxtPreFetch.expects(method, url, query)`
  (synchronous) and `await take(method, url, query)` → `{ data }` once, or `undefined` → fetch.
  Results stay usable after the page rendered — until taken once, the next navigation, or 60 s.
- **Rules** (`dynamic`): absolute URLs only to `dynamic.allowedHosts`, or app-relative `/…`
  (through `event.$fetch`); headers filtered to `dynamic.forwardHeaders`; `auth: { cookie }` only
  for `dynamic.authCookies` — the token is read from the page request (`split: true`: chunked
  into `<cookie>_split_<i>`), never stored. Only 2xx responses are embedded; a request that fails on the server (401/5xx/timeout, too
  large) is reported to the browser, which retries it itself. A handler that throws or exceeds
  `timeout` costs only its requests: the page fetches them as usual.
- **Debug** (`debug: true`): the browser console lists per page what was served, what the server
  planned but couldn't fetch, and what it **didn't predict** — the check that a declaration
  matches the page.
- Playground: `/declared`.

## Learned requests

Without a declaration, a library can still make a page's runtime requests instant from the
**second** visit:

1. The library reports the GET requests a page sent: `useNuxtApp().$nuxtPreFetch.learn({ url, query, headers, auth })`.
   Nitro stores them for that **browser** (an anonymous HttpOnly `npf_id` cookie) and **page** (full path).
2. On the next visit of that page Nitro replays them like declared requests.

```ts
nuxtPreFetch: { dynamic: { allowedHosts: ['api.example.com'], authCookies: ['app_token'] }, learn: { enabled: true } }
```

- **Requests, never data.** Every replay is a fresh fetch. A request that changed since
  (another filter, a new year) simply doesn't match: the page fetches it and the new one is
  learned. The stored set is always what the last visit of the page sent; report served
  requests too.
- Validated when learned and on every replay (same `dynamic` rules); same-origin writes only.
- Storage is Nitro's `nuxt-pre-fetch` mount (in-memory by default: a restart forgets; mount a
  driver for several instances). Other modules can append `allowedHosts` / `authCookies`
  to `runtimeConfig.nuxtPreFetch.dynamic` at build time.
- Playground: `/learned`.

## External APIs (example: PokeAPI)

The playground's `/pokemon` and `/pokemon/[id]` pages are built on
[PokeAPI](https://pokeapi.co/), an allowed external host:

```ts
// nuxt.config.ts
nuxtPreFetch: { external: { allowedHosts: ['pokeapi.co'] } }
```

```ts
// pages/pokemon/index.vue: one request per list page (/pokemon?offset=48)
const route = useRoute()
const { data } = await usePreFetch<PokemonList>('https://pokeapi.co/api/v2/pokemon', {
  query: { limit: 24, offset: computed(() => route.query.offset) },
})

// pages/pokemon/[id].vue: the ~300 KB resource is trimmed on Nitro by `pick`
const { data: pokemon } = await usePreFetch<Pokemon>(
  () => `https://pokeapi.co/api/v2/pokemon/${route.params.id}`,
  { pick: ['id', 'name', 'height', 'weight', 'base_experience', 'types', 'stats', 'abilities'] },
)
```

On a direct load, paging (`?offset=` on the same page), opening a detail page, and
moving to the previous or next Pokémon, the browser never calls `pokeapi.co`. Nitro
fetches everything and no visitor cookies or headers are sent to PokeAPI. Only
`refresh()` in the default `fetchMode: 'client'` calls PokeAPI from the browser.

## Performance

"Data on screen" means milliseconds from navigation start until real data is rendered.
It was measured on the production build in Playwright Chromium, with a cold cache and
the median of 5 runs per cell. The `useFetch` column is the same build with the module
switched off at runtime (`NUXT_PUBLIC_NUXT_PRE_FETCH_ENABLED=false`, i.e. a normal SPA).

| Network | Scenario | `useFetch` | `usePreFetch` | Faster by |
| --- | --- | --- | --- | --- |
| localhost | `/dashboard`: local API ×3 | 141 ms | 135 ms | 4% |
| localhost | `/pokemon`: PokeAPI ×1 | 256 ms | 228 ms | 11% |
| localhost | `/pokemon/25`: PokeAPI ×2 | 281 ms | 250 ms | 11% |
| localhost | click list → detail | 178 ms | 155 ms | 13% |
| slow 4G (150 ms RTT, 4 Mbps) | `/dashboard`: local API ×3 | 1689 ms | 1128 ms | 33% |
| slow 4G | `/pokemon`: PokeAPI ×1 | 1876 ms | 1296 ms | 31% |
| slow 4G | `/pokemon/25`: PokeAPI ×2 | 1867 ms | 1293 ms | 31% |
| slow 4G | click list → detail | 851 ms | 369 ms | 57% |

The playground's `/performance-proof` page shows this live. It is one page and one real page
load (`?pokemon=25,6&move=14,33&ability=65,7&item=17,4&test=<run>`). A run of N requests
is a random mix of four PokeAPI resources (`/pokemon`, `/move`, `/ability`, `/item`), split
evenly: 100 requests = 25 of each, every one a different URL, capped at 500 per side with
`.slice(0, 125)` per resource. The left half uses `useFetch` and the right half `usePreFetch`
(`/pinia` does the same inside Pinia stores). Both halves share an HTML response
that waited for the prefetch, so the left half is reported as standalone, i.e. measured
time minus the `Server-Timing: nuxt-pre-fetch` duration. Before each run the server
fetches the run's URLs once, so PokeAPI's CDN and Nitro's connections are warm for both
sides. Measured on one machine against the real PokeAPI (production build), with the
earlier version of the page (one Pokémon = `/pokemon` + `/pokemon-species`):

| Pokémon (requests per side) | no throttling | browser on Slow 4G |
| --- | --- | --- |
| 1 (2) | usePreFetch ~200 ms sooner in 2 of 3 runs | 117–174 ms sooner |
| 5 (10) | 9–229 ms sooner | ~320 ms sooner |
| 25 (50) | mixed: −193 ms to +81 ms | 664 ms sooner |
| 100 (200) | mixed: −1327 ms to +150 ms | not measured (≈35 MB raw for the browser) |

**When it pays off, and when it doesn't:**

- **It wins on latency.** Every request the browser no longer makes after Vue boots is a
  round trip saved. That gain grows with the user's distance from your server and API.
- **It wins on transfer size** when `pick` is used: Nitro trims responses before embedding
  them, while `useFetch` downloads the full responses.
- **It is no win when the work is bandwidth-bound.** Here many large responses, with the
  server and browser on the same machine and network, means the server has no network
  advantage. Nitro must also receive *everything* before the first byte of HTML goes out.
- **Server connections matter.** Node's `fetch` keeps idle connections for only ~4 s. A
  quiet server pays a fresh TLS handshake per page (~130 ms to PokeAPI here, vs 19 ms
  warm). A busy server mostly doesn't.

The costs are a later first byte for the HTML and more server load. See
[the trade-offs](#limitations-and-compatibility).

Each prefetch adds a standard
`Server-Timing: nuxt-pre-fetch;dur=<ms>;desc="usePreFetch (<n>)"` header to the HTML
response (and to the endpoint). It shows in DevTools → Network → Timing and is readable
via `performance.getEntriesByType('navigation')[0].serverTiming`.

## Server API

`runPrefetch(event, path, { only? })` is auto-imported in Nitro. It returns the payload
for an app route, or `null` when no manifest route matches.

`nuxt-pre-fetch:request` is a Nitro runtime hook called once per request before it runs.
Use it to veto a request or add headers:

```ts
// server/plugins/prefetch-policy.ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('nuxt-pre-fetch:request', (ctx) => {
    if (ctx.request.url.startsWith('/api/admin') && !isAdmin(ctx.event)) ctx.skip = true
  })
})
```

## Security

- **Embedded data is visible to the user.** It sits in the HTML of that user's
  response. Your API must authorise every request, which it does in the normal way:
  same-origin requests run through Nitro's `event.$fetch` with the incoming request's
  cookies and `Authorization` header, so the API sees the same user the browser request
  would have.
- **No cross-user caching.** A document that carries a payload, and every endpoint
  response, is sent with `Cache-Control: private, no-store` and `Vary: Cookie`. Don't
  put such pages behind a shared or ISR cache (`routeRules: { cache/swr/isr }`).
- **No SSRF.** The endpoint takes an app route, never a URL, and runs only requests
  discovered at build time. Route params can fill path segments only (percent-encoded;
  `/`, `?`, `#`, `\`, `.` and `..` are rejected) and never the origin. Absolute URLs run
  only for hosts in `external.allowedHosts`, with only the headers listed in
  `external.forwardHeaders[host]` forwarded. Cookies are never sent to external hosts.
- **No script injection.** The payload is `application/json`, never executed. `<`, `>`,
  `&`, U+2028 and U+2029 are `\u`-escaped, so API data can't close the element.
- **No private config leaks.** Error bodies have `url`/`stack` removed, external error
  bodies aren't embedded, private runtime config never reaches the client, and request
  URLs and headers exist only in the server bundle. The browser only receives the list of
  route patterns that have something to prefetch.
- **CSP.** A `<script type="application/json">` data block is not executed, so it needs
  no nonce and no `script-src` exception.
- **Loop guard.** Prefetch requests carry `x-nuxt-pre-fetch: 1`. `render:html` skips
  requests that have it, and the endpoint rejects them.

## Limitations and compatibility

Verified against Nuxt 4.5.2, Nitro (nitropack) 2.13.4, h3 1.15.11 and Vue 3.5:

- With `ssr: false` and a server preset (`node-server`, …), `@nuxt/nitro-server`'s
  renderer serves the SPA shell per request (`getSPARenderer`) and calls `render:html`.
  **Static output (`nuxt generate`, static presets) has no request-time server**, so the
  module disables its server parts there and `usePreFetch` behaves like `useFetch`.
- With `ssr: true` the module disables itself, since `useFetch` already runs on the
  server. `usePreFetch` is then exactly `useFetch`.
- With `ssr: false` the client starts with `isHydrating === true`, and the default
  `getCachedData` reads `payload.data` but skips `transform`/`pick`. This module doesn't
  use that path. It serves prefetched values through `useFetch`'s `$fetch`, so data is
  transformed exactly once and falsy values stay data.
- Discovery covers pages and the Pinia setup stores and composables they call at setup.
  Fetches that start in child components or layouts are not discovered. See
  [What is prefetched](#what-is-prefetched).
- The route matcher supports the paths Nuxt generates (`[id]`, `[[id]]`, `[...slug]`,
  `prefix-[id]`). Custom `definePageMeta({ path })` regexes with capture groups are
  reported and fall back to client fetching.
- Only GET requests whose responses are JSON-serialisable are prefetched. `Date`s become
  strings, exactly as they would through `$fetch`.
- The peer range is `nuxt >= 3.17`, the first release with every API this module relies
  on (the `useFetch` `$fetch` option, `page:loading:end`, kit's `addServerTemplate`).
  It has only been tested end-to-end on Nuxt 4.5.2 and nitropack 2. Nitro v3 / h3 v2
  are not supported yet.

## Development

```sh
pnpm install
pnpm nuxt-pre-fetch build        # tsdown → dist/
pnpm nuxt-pre-fetch dev          # playground (ssr: false), sources
pnpm nuxt-pre-fetch typecheck    # package + playground (app and Nitro contexts)
pnpm nuxt-pre-fetch test         # unit + e2e (production build of the playground against dist/)
```

The e2e suite uses Playwright Chromium (`npx playwright-core install chromium`). It
counts where every API request comes from, using the playground's `/api/hits`. For
example, it asserts that the initial load makes **zero** browser requests to `/api/*`,
and that navigation goes through `/__nuxt_pre_fetch` only.

## License

MIT
