import type { RouteMiddleware } from 'nuxt/app'
import { defineNuxtRouteMiddleware, useNuxtApp } from '#imports'
import { routes } from '#build/nuxt-pre-fetch/routes.mjs'
import type { PreFetchStore } from '../utils/store'
import { addEntry, addFailure, beginStream, endStream, fillStore, parseEntry, parseFailure, parsePayload, resetStore, usePreFetchStore } from '../utils/store'
import { debugLog, getPublicOptions } from '../utils/fetch'
import type { LearnedBucket } from '../utils/learned'
import { addLearned, endLearned, expectLearned, failLearned, resetLearned, useLearnedBucket } from '../utils/learned'

const prefetchRoutes = routes as RegExp[]

/** Reads an NDJSON body line by line; stops quietly when the store moved on. */
async function readStream(body: ReadableStream<Uint8Array>, store: PreFetchStore, generation: number, bucket: LearnedBucket): Promise<number> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let count = 0
  const learned = new Set<string>()
  const handle = (line: string) => {
    if (!line.trim() || store.generation !== generation) return
    let value: unknown
    try {
      value = JSON.parse(line)
    }
    catch {
      return
    }
    const message = value as { id?: unknown, entry?: unknown, runtime?: unknown, failed?: unknown }
    if (Array.isArray(message.runtime)) {
      // First line: runtime ids that will (maybe) arrive; libraries wait for them.
      const ids = message.runtime.filter((id): id is string => typeof id === 'string')
      for (const id of ids) learned.add(id)
      expectLearned(bucket, ids)
      return
    }
    if (typeof message.id !== 'string') return // first (`v`) and last (`done`) lines
    if (message.failed !== undefined) {
      // Failed on the server: whoever waits for it fetches it from the browser right away.
      const failure = parseFailure(message.failed)
      if (failure) {
        addFailure(store, message.id, failure)
        failLearned(bucket, message.id, failure)
      }
      return
    }
    const entry = parseEntry(message.entry)
    if (entry) {
      if (learned.has(message.id)) addLearned(bucket, message.id, entry)
      addEntry(store, message.id, entry)
      count++
    }
  }
  try {
    while (store.generation === generation) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        handle(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
    handle(buffer + decoder.decode())
  }
  finally {
    reader.releaseLock()
  }
  return count
}

/**
 * Client navigation: before the destination page sets up, ask Nitro to run that route's
 * manifest requests (same runner as the HTML hook) and load the results into the store.
 * Never redirects or blocks a navigation on failure; waits at most `navigationTimeout`.
 *
 * - `streamNavigation` (default): the endpoint streams each result as soon as its request
 *   finishes. The navigation only waits until the stream has STARTED; every usePreFetch
 *   waits for its own entry, so the page renders progressively instead of after the
 *   slowest request.
 * - otherwise: one JSON response with every result; the navigation waits for it.
 */
const middleware: RouteMiddleware = defineNuxtRouteMiddleware(async (to, from) => {
  if (import.meta.server) return
  const nuxtApp = useNuxtApp()
  const options = getPublicOptions(nuxtApp)
  if (!options?.enabled || !options.clientNavigation) return
  // Initial navigation: the data came with the HTML document.
  if (nuxtApp.isHydrating) return
  if (to.fullPath === from.fullPath) return
  // Hash-only change: same page, same data.
  if (to.path === from.path && JSON.stringify(to.query) === JSON.stringify(from.query)) return

  const store = usePreFetchStore(nuxtApp)
  resetStore(store)
  const bucket = useLearnedBucket(nuxtApp)
  const targetPath = to.fullPath.split('#')[0]!
  resetLearned(bucket, targetPath)
  const learnedPage = !!options.learn && bucket.paths.has(targetPath)
  if (!learnedPage && !prefetchRoutes.some(re => re.test(to.path))) return

  const generation = store.generation
  const controller = new AbortController()
  store.controller = controller
  const startedAt = Date.now()

  // Pinia setup stores run their setup (and its usePreFetch calls) once per app: tell
  // Nitro which are already active so it skips their requests. (`_s` is Pinia's store
  // registry; absent without Pinia.)
  const pinia = (nuxtApp as { $pinia?: { _s?: Map<string, unknown> } }).$pinia
  const activeStores = pinia?._s instanceof Map ? [...pinia._s.keys()] : []
  const query: Record<string, string> = { path: to.fullPath }
  if (activeStores.length) query.skipStores = activeStores.join(',')

  let request: Promise<void>
  if (options.streamNavigation) {
    query.stream = '1'
    const base = (nuxtApp.$config.app as { baseURL?: string }).baseURL ?? '/'
    const url = `${base.replace(/\/+$/, '')}${options.endpoint}?${new URLSearchParams(query)}`
    // Resolves once the stream has started (response headers); entries keep arriving after.
    request = fetch(url, { signal: controller.signal, headers: { accept: 'application/x-ndjson' }, credentials: 'same-origin' })
      .then((response) => {
        if (store.generation !== generation) return
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        beginStream(store, to.fullPath)
        readStream(response.body, store, generation, bucket)
          .then(count => debugLog(options, `navigation prefetch ${to.fullPath}: streamed ${count} entries in ${Date.now() - startedAt}ms`))
          .catch((error: unknown) => debugLog(options, `navigation prefetch ${to.fullPath}: stream interrupted`, error))
          .finally(() => {
            if (store.generation === generation) {
              endStream(store)
              endLearned(bucket)
            }
          })
      })
      .catch((error: unknown) => {
        debugLog(options, `navigation prefetch ${to.fullPath} failed`, error)
      })
      .finally(() => {
        if (store.generation === generation) store.pending = null
      })
  }
  else {
    request = (globalThis.$fetch as unknown as (url: string, init: Record<string, unknown>) => Promise<unknown>)(
      options.endpoint,
      { query, signal: controller.signal },
    ).then((response) => {
      if (store.generation !== generation) return // superseded by a newer navigation
      const payload = parsePayload(response)
      if (payload) {
        fillStore(store, payload)
        for (const id of payload.runtime ?? []) {
          const entry = payload.entries[id]
          if (entry) addLearned(bucket, id, entry)
        }
        for (const [id, failure] of Object.entries(payload.failed ?? {})) failLearned(bucket, id, failure)
        debugLog(options, `navigation prefetch ${to.fullPath}: ${Object.keys(payload.entries).length} entries in ${Date.now() - startedAt}ms`)
      }
    }).catch((error: unknown) => {
      debugLog(options, `navigation prefetch ${to.fullPath} failed`, error)
    }).finally(() => {
      if (store.generation === generation) store.pending = null
    })
  }
  store.pending = request

  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    request,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.navigationTimeout)
    }),
  ])
  clearTimeout(timer)
})

export default middleware
