import type { Plugin } from 'nuxt/app'
import { defineNuxtPlugin } from '#imports'
import { PAYLOAD_ELEMENT_ID } from '../shared/identity'
import type { LearnedRequest } from '../shared/types'
import { closeStore, fillStore, parsePayload, usePreFetchStore } from '../utils/store'
import { debugLog, getPublicOptions } from '../utils/fetch'
import { addLearned, createLearnQueue, expectsLearned, failLearned, learnedIdentity, resetLearned, takeLearned, useLearnedBucket } from '../utils/learned'

/**
 * Public runtime API (`useNuxtApp().$nuxtPreFetch`) for libraries whose requests are built
 * at runtime and can't be discovered at build time (e.g. a data layer). They report the
 * GET requests a page sends (`learn`); on the next visit of that page Nitro replays them
 * and the library asks for the result before sending (`expects` / `take`).
 */
export interface NuxtPreFetchApi {
  /** Server prefetching is active: runtime results (definePrefetch / learned) can be served. */
  readonly serving: boolean
  /** Learning is enabled: `learn()` reports requests. */
  readonly learning: boolean
  /** Request identity, as the server computes it. */
  identity: (method: string, url: string, query?: Record<string, unknown> | null) => string
  /** Synchronous: a runtime result is available (or arriving) for this request on this page. */
  expects: (method: string, url: string, query?: Record<string, unknown> | null) => boolean
  /** The runtime result (`{ data }`), once; `undefined` = fetch it yourself. */
  take: (method: string, url: string, query?: Record<string, unknown> | null) => Promise<{ data: unknown } | undefined>
  /**
   * Reports a GET request the current page sent (or would have sent: report served ones
   * too, the stored set is always what the last visit used). Never pass tokens: name the
   * cookie with `auth` instead.
   */
  learn: (request: LearnedRequest) => void
}

/**
 * Reads the `<script type="application/json">` payload Nitro embedded in the
 * HTML shell, exactly once, before any page sets up (`enforce: 'pre'`; page
 * components only run after every plugin has finished, so no further ordering
 * is needed), then removes the element unless `keepPayload` is set. Entries
 * live in a dedicated store — `nuxtApp.payload.data` is never touched, so
 * unrelated `useAsyncData` keys cannot collide with them.
 */
const plugin: Plugin<{ nuxtPreFetch: NuxtPreFetchApi }> = defineNuxtPlugin({
  name: 'nuxt-pre-fetch:payload',
  enforce: 'pre',
  setup(nuxtApp) {
    const options = getPublicOptions(nuxtApp)
    const store = usePreFetchStore(nuxtApp)
    const bucket = useLearnedBucket(nuxtApp)
    const learning = !!options?.enabled && !!options.learn
    const currentPath = () => {
      const route = nuxtApp.$router?.currentRoute?.value
      return (route?.fullPath ?? `${location.pathname}${location.search}`).split('#')[0]!
    }

    /** Debug: runtime ids the server planned for the first page (fetched or not). */
    const planned = new Set<string>()
    if (!store.initialized) {
      store.initialized = true
      resetLearned(bucket, currentPath())

      const element = document.getElementById(PAYLOAD_ELEMENT_ID)
      if (element) {
        const payload = parsePayload(element.textContent ?? '')
        // The data is used from the store either way; `keepPayload` only leaves the element in the DOM.
        if (!options?.keepPayload) element.remove()
        if (payload) {
          fillStore(store, payload)
          for (const id of payload.runtime ?? []) {
            const entry = payload.entries[id]
            if (entry) addLearned(bucket, id, entry)
          }
          for (const [id, failure] of Object.entries(payload.failed ?? {})) failLearned(bucket, id, failure)
          for (const path of payload.paths ?? []) bucket.paths.add(path)
          for (const id of payload.planned ?? []) planned.add(id)
          debugLog(options, `payload for ${payload.path}: ${Object.keys(payload.entries).length} entries (${payload.runtime?.length ?? 0} runtime)`)
        }
        else {
          console.warn('[nuxt-pre-fetch] ignored a malformed prefetch payload')
        }
      }

      // A rendered page never reads prefetched data again: refresh(), watchers and
      // later remounts go to the network. (Learned results have their own lifetime.)
      nuxtApp.hook('page:loading:end', () => closeStore(store))
      nuxtApp.hook('app:created', () => {
        // Query/hash-only navigations keep the page component (no suspense, so no
        // page:loading:end): close once the synchronous watchers have consumed.
        nuxtApp.$router?.afterEach((to, from) => {
          if (to.path === from.path) setTimeout(() => closeStore(store), 0)
        })
      })
    }

    const endpoint = `${((nuxtApp.$config.app as { baseURL?: string }).baseURL ?? '/').replace(/\/+$/, '')}${options?.endpoint ?? '/__nuxt_pre_fetch'}/learn`
    const queue = createLearnQueue((body, beacon) => {
      const path = (JSON.parse(body) as { path: string }).path
      bucket.paths.add(path)
      if (beacon && navigator.sendBeacon?.(endpoint, body)) return
      fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'application/json' }, credentials: 'same-origin', keepalive: true })
        .catch((error: unknown) => debugLog(options, 'learn failed', error))
    })
    if (learning) {
      addEventListener('pagehide', () => queue.flush(true))
      nuxtApp.hook('app:created', () => {
        nuxtApp.$router?.beforeEach((to, from) => {
          queue.flush()
          // Without the navigation middleware nothing else drops the previous page's results.
          if (!options?.clientNavigation && to.fullPath !== from.fullPath) resetLearned(bucket, to.fullPath.split('#')[0]!)
        })
      })
    }

    const serving = !!options?.enabled

    // Debug: per page, which requests were answered from the prefetch, which the server planned
    // but couldn't fetch (e.g. 401), and which it didn't predict at all — the check that a page's
    // definePrefetch is complete. Logged 3 s after the page's last request; also on
    // `window.__nuxtPreFetchReport`.
    type Line = { method: string, url: string, query?: unknown, id: string }
    const report = { path: '', served: [] as Line[], retriedOnClient: [] as Array<Line & { serverError: string }>, plannedNotFetched: [] as Line[], notPredicted: [] as Line[], unusedIds: [] as string[] }
    let reportTimer: ReturnType<typeof setTimeout> | undefined
    const note = (kind: 'served' | 'missed', method: string, url: string, query: unknown, id: string) => {
      if (!options?.debug) return
      const path = currentPath()
      if (report.path !== path) {
        report.path = path
        report.served = []
        report.retriedOnClient = []
        report.plannedNotFetched = []
        report.notPredicted = []
      }
      const line = { method, url, query, id }
      const failure = bucket.failed.get(id)
      if (kind === 'served') report.served.push(line)
      else if (failure) report.retriedOnClient.push({ ...line, serverError: String(failure.s ?? failure.r) })
      else if (planned.has(id)) report.plannedNotFetched.push(line)
      else report.notPredicted.push(line)
      clearTimeout(reportTimer)
      reportTimer = setTimeout(() => {
        report.unusedIds = bucket.path === path ? [...bucket.entries.keys()] : []
        ;(globalThis as { __nuxtPreFetchReport?: unknown }).__nuxtPreFetchReport = report
        console.debug(`[nuxt-pre-fetch] ${path}: served ${report.served.length}, retried on the client after a server error ${report.retriedOnClient.length}, planned but not fetched ${report.plannedNotFetched.length}, not predicted ${report.notPredicted.length}, prefetched but unused ${report.unusedIds.length}`, report)
      }, 3000)
    }

    const api: NuxtPreFetchApi = {
      serving,
      learning,
      identity: (method, url, query) => learnedIdentity(method, url, query),
      expects: (method, url, query) => {
        if (!serving) return false
        const id = learnedIdentity(method, url, query)
        const expected = expectsLearned(bucket, id)
        if (!expected) {
          const failure = bucket.failed.get(id)
          if (failure) debugLog(options, `${method} ${url} failed on the server (${failure.s ?? failure.r}) → retried on the client`)
          note('missed', method, url, query, id)
        }
        return expected
      },
      take: async (method, url, query) => {
        if (!serving) return undefined
        const id = learnedIdentity(method, url, query)
        const hit = await takeLearned(bucket, id)
        note(hit ? 'served' : 'missed', method, url, query, id)
        return hit
      },
      learn: (request) => {
        if (!learning || !request || typeof request.url !== 'string') return
        queue.add(currentPath(), request)
      },
    }
    return { provide: { nuxtPreFetch: api } }
  },
})

export default plugin
