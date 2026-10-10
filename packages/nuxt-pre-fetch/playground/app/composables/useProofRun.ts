import type { Ref } from 'vue'

/** What a proof page tells `useProofRun` about one side (useFetch / usePreFetch). */
export interface ProofSideSource {
  /** Status of every request of this side (`useAsyncData` status values). */
  statuses: () => string[]
  /** Requests this side really sent from the browser so far. */
  browserRequests: () => number
}

export interface UseProofRunOptions {
  /** sessionStorage key: each proof page keeps its own runs. */
  storageKey: string
  /** The page was opened by a run (`?test=…`): measure it. */
  testing: boolean
  sides: Record<ProofMode, ProofSideSource>
  /** What this run measured (for the runs table). */
  describe: () => Pick<ProofRun, 'ids' | 'names' | 'label' | 'requestsPerSide'>
}

export interface ProofRunState {
  runs: Ref<ProofRun[]>
  /** The run measured on this page load, once both sides are on screen. */
  current: Ref<ProofRun | null>
  /** `current`, else the latest stored run. */
  shown: Ref<ProofRun | null>
  /** This page load was not prefetched by the server (no `Server-Timing: nuxt-pre-fetch`). */
  notPrefetched: Ref<boolean>
  clear: () => void
}

/**
 * Measures one proof run: for each side, when ALL of its requests have settled it waits
 * for the paint and takes the time since the run started. When both sides are done the
 * run is stored (sessionStorage) next to earlier ones.
 *
 * - Page-load run ("Run random", or a browser reload): times since navigation start; the
 *   right side's data came in the HTML.
 * - In-place run (`runProofInPlace`, client-side route change): times since that route
 *   change started; the right side's data came through the prefetch endpoint.
 */
export function useProofRun(options: UseProofRunOptions): ProofRunState {
  const route = useRoute()
  const nuxtApp = useNuxtApp()
  const endpoint = (useRuntimeConfig().public.nuxtPreFetch as { endpoint?: string } | undefined)?.endpoint ?? '/__nuxt_pre_fetch'
  // Keep every API timing entry (the default buffer holds only 250 resources).
  if (options.testing) performance.setResourceTimingBufferSize(100_000)
  const marks = reactive<Record<ProofMode, { data: number | null, error: boolean }>>({
    useFetch: { data: null, error: false },
    usePreFetch: { data: null, error: false },
  })
  const runs = ref<ProofRun[]>([])
  const current = ref<ProofRun | null>(null)
  const notPrefetched = ref(false)

  // Which kind of run this mount is. A client navigation onto a run URL that this tab
  // didn't start (e.g. history back) only shows the data: there is nothing to time it from.
  const documentLoad = nuxtApp.isHydrating
  const clientStart = !documentLoad && options.testing ? takePendingClientRun(String(route.query.test)) : null
  const kind: 'load' | 'navigation' = documentLoad ? 'load' : 'navigation'
  const measuring = options.testing && (documentLoad || clientStart !== null)
  const origin = clientStart ?? 0

  // A browser reload of a run page is measured again as a NEW run (same Pokémon, no
  // explicit warm-up before it, so it is listed as cold).
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const reloaded = documentLoad && navigation?.type === 'reload'
  const runId = reloaded ? `${route.query.test}-reload-${Date.now()}` : String(route.query.test ?? Date.now())

  /**
   * In-place run: the prefetch endpoint call and the API requests after the route change
   * started. With streaming the route change only waits until the stream STARTS (first byte);
   * without it, until the whole response arrived.
   */
  const measureInPlace = (prefetch: PerformanceResourceTiming | undefined): Pick<ProofRun, 'ttfb' | 'html' | 'serverPrefetch' | 'payloadBytes' | 'requests'> => {
    const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(entry => entry.startTime >= origin)
    const streamed = !!prefetch?.serverTiming?.some(timing => timing.name === 'nuxt-pre-fetch' && timing.description.includes('streamed'))
    const waited = prefetch ? (streamed ? prefetch.responseStart : prefetch.responseEnd) - origin : 0
    return {
      ttfb: 0,
      html: waited,
      serverPrefetch: waited,
      payloadBytes: prefetch?.decodedBodySize ?? 0,
      requests: resources
        .filter(entry => entry.name.includes('pokeapi.co'))
        .map(entry => ({ url: new URL(entry.name).pathname, start: entry.startTime - origin, end: entry.responseEnd - origin })),
    }
  }

  // Every prefetch (HTML or endpoint) carries `Server-Timing: nuxt-pre-fetch`.
  const timed = (entry: PerformanceResourceTiming | PerformanceNavigationTiming | undefined) => !!entry?.serverTiming?.some(timing => timing.name === 'nuxt-pre-fetch')
  const endpointEntry = () => (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .filter(entry => entry.startTime >= origin && new URL(entry.name).pathname === endpoint)
    .at(-1)
  /**
   * The browser records a request in the performance timeline only once its response has
   * FINISHED, so a streamed prefetch shows up after the stream ends: wait for it (bounded).
   */
  const waitForEndpointEntry = () => new Promise<PerformanceResourceTiming | undefined>((resolve) => {
    const found = endpointEntry()
    if (found) return resolve(found)
    const observer = new PerformanceObserver(() => {
      const entry = endpointEntry()
      if (entry) {
        observer.disconnect()
        resolve(entry)
      }
    })
    observer.observe({ type: 'resource' })
    setTimeout(() => {
      observer.disconnect()
      resolve(endpointEntry())
    }, 10_000)
  })

  const settled = (status: string) => status === 'success' || status === 'error'
  let finishing = false
  const finish = async () => {
    if (finishing || current.value || marks.useFetch.data === null || marks.usePreFetch.data === null) return
    finishing = true
    let timings: Pick<ProofRun, 'ttfb' | 'html' | 'serverPrefetch' | 'payloadBytes' | 'requests'>
    if (kind === 'load') {
      timings = measurePageLoad()
      notPrefetched.value = !timed(navigation)
    }
    else {
      const prefetch = await waitForEndpointEntry()
      timings = measureInPlace(prefetch)
      notPrefetched.value = !timed(prefetch)
    }
    const run: ProofRun = {
      run: runId,
      kind,
      ...options.describe(),
      warmed: !reloaded && wasWarmed(),
      ...timings,
      useFetch: { ...marks.useFetch, browserRequests: options.sides.useFetch.browserRequests() },
      usePreFetch: { ...marks.usePreFetch, browserRequests: options.sides.usePreFetch.browserRequests() },
    }
    current.value = run
    runs.value = saveProofRun(run, options.storageKey)
  }

  for (const mode of ['useFetch', 'usePreFetch'] as const) {
    watch(options.sides[mode].statuses, (statuses) => {
      if (!measuring || marks[mode].data !== null || !statuses.length || !statuses.every(settled)) return
      nextTick(() => requestAnimationFrame(() => setTimeout(() => {
        marks[mode] = { data: performance.now() - origin, error: statuses.includes('error') }
        finish()
      }, 0)))
    }, { immediate: true })
  }

  onMounted(() => {
    runs.value = readProofRuns(options.storageKey)
    // Page load: the HTML's Server-Timing is known now. (In-place runs: decided in finish().)
    if (measuring && kind === 'load') notPrefetched.value = !timed(navigation)
  })

  return {
    runs,
    current,
    shown: computed(() => current.value ?? runs.value[0] ?? null),
    notPrefetched,
    clear: () => {
      clearProofRuns(options.storageKey)
      runs.value = []
    },
  }
}
