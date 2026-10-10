// Proof pages (/performance-proof, /pinia): ONE page, ONE page load, both sides at once.
//   /performance-proof?pokemon=25,6&move=14,85&ability=65,22&item=17,1&test=<run>
// A run is a random mix of 4 different PokeAPI resources (split evenly). The left half
// loads every request with `useFetch`, the right half with `usePreFetch`. Each half records
// when ALL of its data is on screen. Finished runs live in sessionStorage.

export type ProofMode = 'useFetch' | 'usePreFetch'

/** The PokeAPI resources a run mixes, with the id range each one densely covers. */
export const PROOF_RESOURCES = [
  { kind: 'pokemon', label: 'Pokémon', maxId: 1025 },
  { kind: 'move', label: 'Moves', maxId: 919 },
  { kind: 'ability', label: 'Abilities', maxId: 307 },
  { kind: 'item', label: 'Items', maxId: 1000 },
] as const
export type ProofResource = typeof PROOF_RESOURCES[number]['kind']
/** Random ids per resource: `{ pokemon: ['25', '6'], move: ['14'], … }`. */
export type ProofMix = Record<ProofResource, string[]>

/**
 * At most this many requests per side (PROOF_MAX_PER_RESOURCE for each of the 4 resources).
 * Kept in sync by hand with the literal `.slice(0, 125)` in the proof pages/stores (build-time
 * analysis needs the literal), with `maxListItems` in nuxt.config and /api/proof-warm.
 */
export const PROOF_MAX_REQUESTS = 500
export const PROOF_MAX_PER_RESOURCE = 125

export interface ProofRequest {
  url: string
  /** ms after the run started */
  start: number
  end: number
}

export interface ProofSide {
  /** ms from the run's start until all of this side's data was rendered (null: never). */
  data: number | null
  error: boolean
  /** Requests this side's composables actually sent from the browser. */
  browserRequests: number
}

export interface ProofRun {
  run: string
  /** `kind:id` of every request of the run, e.g. `move:14`. */
  ids: string[]
  names: string[]
  /** Requests per side (older runs: 2 per id). */
  requestsPerSide?: number
  /** What was measured, for the runs table (falls back to `names`). */
  label?: string
  /**
   * `load`: a real page load ("Run random", or a browser reload), times since navigation start.
   * `navigation`: an in-place run (client-side route change), times since that navigation started;
   * the right side came through the prefetch endpoint instead of the HTML.
   */
  kind?: 'load' | 'navigation'
  /** PokeAPI's cache was warmed for the run's URLs right before it. */
  warmed: boolean
  /** HTML first byte / fully received (shared by both halves). */
  ttfb: number
  html: number
  /** How long the right side's prefetch held the page (HTML, or route change in place). */
  serverPrefetch: number
  /** Size of the embedded / streamed prefetch payload. */
  payloadBytes: number
  /** Every PokeAPI request the browser made during this run. */
  requests: ProofRequest[]
  useFetch: ProofSide
  usePreFetch: ProofSide
}

const STORAGE_KEY = 'nuxt-pre-fetch:performance-proof'
const WARM_KEY = 'nuxt-pre-fetch:performance-proof:warmed'

export function readProofRuns(key: string = STORAGE_KEY): ProofRun[] {
  try {
    const runs = JSON.parse(sessionStorage.getItem(key) ?? '') as ProofRun[]
    if (Array.isArray(runs)) return runs.filter(run => Array.isArray(run.ids))
  }
  catch {}
  return []
}

function writeProofRuns(runs: ProofRun[], key: string = STORAGE_KEY): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(runs.slice(0, 50)))
  }
  catch {}
}

export function clearProofRuns(key: string = STORAGE_KEY): void {
  writeProofRuns([], key)
}

export function saveProofRun(run: ProofRun, key: string = STORAGE_KEY): ProofRun[] {
  const runs = [run, ...readProofRuns(key).filter(r => r.run !== run.run)]
  writeProofRuns(runs, key)
  return runs
}

/** Distinct random ids in 1..maxId. */
function randomIds(count: number, maxId: number): string[] {
  const pool = Array.from({ length: maxId }, (_, i) => String(i + 1))
  const ids: string[] = []
  while (ids.length < count && pool.length) ids.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!)
  return ids
}

/** `total` random requests split evenly over the 4 resources (the first ones get the remainder). */
export function randomProofMix(total: number): ProofMix {
  const count = Math.min(PROOF_MAX_REQUESTS, Math.max(1, Math.floor(total)))
  const base = Math.floor(count / PROOF_RESOURCES.length)
  const remainder = count % PROOF_RESOURCES.length
  return Object.fromEntries(PROOF_RESOURCES.map((resource, index) =>
    [resource.kind, randomIds(base + (index < remainder ? 1 : 0), resource.maxId)],
  )) as ProofMix
}

/** The mix of the current URL: each list deduplicated and capped like the pages do. */
export function proofMixFromQuery(query: Record<string, unknown>): ProofMix {
  return Object.fromEntries(PROOF_RESOURCES.map(resource => [
    resource.kind,
    [...new Set(String(query[resource.kind] ?? '').split(',').slice(0, PROOF_MAX_PER_RESOURCE).filter(Boolean))],
  ])) as ProofMix
}

export const proofMixSize = (mix: ProofMix): number => PROOF_RESOURCES.reduce((sum, resource) => sum + mix[resource.kind].length, 0)
export const proofMixUrls = (mix: ProofMix): string[] => PROOF_RESOURCES.flatMap(resource => mix[resource.kind].map(id => `https://pokeapi.co/api/v2/${resource.kind}/${id}`))
/** `{ pokemon: '25,6', move: '14', … }` (empty resources left out). */
const proofMixQuery = (mix: ProofMix): Record<string, string> => Object.fromEntries(
  PROOF_RESOURCES.filter(resource => mix[resource.kind].length).map(resource => [resource.kind, mix[resource.kind].join(',')]),
)

async function warmUp(mix: ProofMix, warm: boolean): Promise<void> {
  if (warm) await $fetch('/api/proof-warm', { method: 'POST', body: { urls: proofMixUrls(mix) } }).catch(() => undefined)
  try {
    sessionStorage.setItem(WARM_KEY, warm ? '1' : '0')
  }
  catch {}
}

/**
 * "Run random": optionally warms up on the server (PokeAPI CDN cache + Nitro's connections,
 * see /api/proof-warm), then a real browser navigation (full page load) to `path`.
 */
export async function reloadForProof(path: string, mix: ProofMix, warm: boolean): Promise<void> {
  await warmUp(mix, warm)
  // Commas stay readable (`?move=14,85`); everything else is encoded.
  const search = Object.entries({ ...proofMixQuery(mix), test: String(Date.now()) })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value).replace(/%2C/gi, ',')}`)
    .join('&')
  location.assign(`${path}?${search}`)
}

/** An in-place run whose route change is in flight (set right before navigating). */
let pendingClientRun: { test: string, t0: number } | null = null

/** The start time of the in-place run `test`, once (null: this mount is not that run). */
export function takePendingClientRun(test: string): number | null {
  if (!pendingClientRun || pendingClientRun.test !== test) return null
  const { t0 } = pendingClientRun
  pendingClientRun = null
  return t0
}

/**
 * An in-place run, without reloading: optionally warms up on the server, then pushes the mix
 * and `test` onto the route with a client-side navigation. The page remounts (its `key` is
 * the full path) and fetches right away: the useFetch side from the browser, the usePreFetch
 * side through Nitro's prefetch endpoint (client-navigation prefetch).
 * `beforeNavigate` runs just before the route changes (Pinia: dispose the old stores).
 */
export async function runProofInPlace(path: string, mix: ProofMix, warm: boolean, beforeNavigate?: () => void): Promise<void> {
  await warmUp(mix, warm)
  beforeNavigate?.()
  const test = String(Date.now())
  pendingClientRun = { test, t0: performance.now() }
  await navigateTo({ path, query: { ...proofMixQuery(mix), test } }, { replace: true })
}

export function wasWarmed(): boolean {
  try {
    return sessionStorage.getItem(WARM_KEY) === '1'
  }
  catch {
    return false
  }
}

/** Page-level timings of the current page load. */
export function measurePageLoad(): Pick<ProofRun, 'ttfb' | 'html' | 'serverPrefetch' | 'payloadBytes' | 'requests'> {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const requests = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .filter(entry => entry.name.includes('pokeapi.co'))
    .map(entry => ({ url: new URL(entry.name).pathname, start: entry.startTime, end: entry.responseEnd }))
  return {
    ttfb: nav?.responseStart ?? 0,
    html: nav?.responseEnd ?? 0,
    serverPrefetch: nav?.serverTiming?.find(entry => entry.name === 'nuxt-pre-fetch')?.duration ?? 0,
    payloadBytes: document.getElementById('__NUXT_PRE_FETCH__')?.textContent?.length ?? 0,
    requests,
  }
}

/** One request of a proof run (an AsyncData from a page, or its Pinia-unwrapped form). */
export interface ProofItem {
  kind: ProofResource
  id: string
  request: { data: unknown, error: unknown, status: unknown }
}

/** Status of every request (works for page refs and Pinia-unwrapped store values). */
export function proofStatuses(items: ProofItem[]): string[] {
  return items.filter(item => item.id).map(item => toValue(item.request.status) as string)
}

/** The display name PokeAPI gives every resource. */
export function proofItemName(item: ProofItem): string {
  return (toValue(item.request.data) as { name?: string } | null | undefined)?.name ?? `${item.kind} ${item.id}`
}

/** The cost of the left half as its own page: the HTML would not wait for the prefetch. */
export function useFetchStandalone(run: ProofRun): number | null {
  return run.useFetch.data === null ? null : run.useFetch.data - run.serverPrefetch
}
