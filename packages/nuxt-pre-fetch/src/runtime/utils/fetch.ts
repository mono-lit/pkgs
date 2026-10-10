import type { NuxtApp } from 'nuxt/app'
import { createError } from '#imports'
import type { PayloadEntry, PublicRuntimeOptions } from '../shared/types'
import { parsePayload, takeEntry, usePreFetchStore } from './store'
import { prefetchIdentity } from './request'

type FetchLike = (request: unknown, options?: Record<string, unknown>) => Promise<unknown>

export function getPublicOptions(nuxtApp: NuxtApp): PublicRuntimeOptions | undefined {
  return (nuxtApp.$config.public as { nuxtPreFetch?: PublicRuntimeOptions }).nuxtPreFetch
}

export function debugLog(options: PublicRuntimeOptions | undefined, ...args: unknown[]): void {
  if (options?.debug) console.debug('[nuxt-pre-fetch]', ...args)
}

function unpack(entry: PayloadEntry): unknown {
  if ('e' in entry) {
    throw createError({ statusCode: entry.e.s, statusMessage: entry.e.m, data: entry.e.d })
  }
  return entry.d
}

const warnedMisses = new Set<string>()

/**
 * The `$fetch` handed to `useFetch` by `usePreFetch`. One instance per
 * composable call: the first time it sees a request id it serves the
 * prefetched result (no network); every later call (refresh, watch, key change
 * back) goes to the network according to `fetchMode`.
 */
export function createPreFetchFetch(nuxtApp: NuxtApp, base?: FetchLike): FetchLike {
  const store = usePreFetchStore(nuxtApp)
  const consumed = new Set<string>()

  return async (request, fetchOptions = {}) => {
    const options = getPublicOptions(nuxtApp)
    const fetcher = base ?? (globalThis.$fetch as unknown as FetchLike)
    const id = prefetchIdentity(request, fetchOptions)

    if (id && !consumed.has(id)) {
      consumed.add(id)
      const startedAt = Date.now()
      const entry = await takeEntry(store, id)
      if (entry) {
        debugLog(options, `hit ${String(request)} (${Date.now() - startedAt}ms)`)
        return unpack(entry)
      }
      const failure = store.failed.get(id)
      if (failure) {
        // Failed on the server: retry it from the browser (whatever `fetchMode` says — the
        // server already tried), with this request's own error handling.
        debugLog(options, `${String(request)} failed on the server (${failure.s ?? failure.r}) → retried on the client`)
        return fetcher(request, fetchOptions)
      }
      if (import.meta.dev && store.open && !warnedMisses.has(id)) {
        warnedMisses.add(id)
        console.warn(`[nuxt-pre-fetch] GET ${String(request)} was not prefetched for ${store.path}. Only statically analysable calls at the top level of a page's <script setup> are prefetched; this one is fetched from the browser.`)
      }
    }

    if (options?.fetchMode === 'server') {
      if (id) {
        const router = nuxtApp.$router as { currentRoute: { value: { fullPath: string } } } | undefined
        const path = router?.currentRoute.value.fullPath ?? '/'
        const response = await fetcher(options.endpoint, {
          query: { path, id },
          signal: fetchOptions.signal,
          ignoreResponseError: true,
        })
        const entry = parsePayload(response)?.entries[id]
        if (entry) {
          debugLog(options, `server refresh ${String(request)}`)
          return unpack(entry)
        }
      }
      if (options.fallback === 'error') {
        throw createError({
          statusCode: 501,
          statusMessage: `usePreFetch: ${String(request)} cannot be executed on the server (not statically discovered) and fallback is 'error'`,
        })
      }
    }

    debugLog(options, `miss ${String(request)} → client fetch`)
    return fetcher(request, fetchOptions)
  }
}

