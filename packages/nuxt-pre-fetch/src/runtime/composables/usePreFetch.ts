import type { useFetch as UseFetch } from 'nuxt/app'
import { toValue } from 'vue'
import { useFetch, useNuxtApp } from '#imports'
import { createPreFetchFetch, getPublicOptions } from '../utils/fetch'
import { asyncDataKeyFor } from '../utils/request'

/**
 * `useFetch()` whose initial result is prefetched by Nitro and embedded in the
 * HTML (first load) or fetched through the prefetch endpoint (client
 * navigation), so the page does not issue the request itself.
 *
 * Same signature, options and return value as `useFetch()`: it IS `useFetch`
 * with a cache-aware `$fetch` and a request-identity based default `key`.
 */
export const usePreFetch: typeof UseFetch = ((request: unknown, arg1?: unknown, arg2?: unknown) => {
  const opts = (typeof arg1 === 'string' ? {} : arg1 ?? {}) as Record<string, any>
  const autoKey = typeof arg1 === 'string' ? arg1 : arg2 as string | undefined
  const nuxtApp = useNuxtApp()
  const call = useFetch as unknown as (...args: unknown[]) => unknown

  if (import.meta.server || !getPublicOptions(nuxtApp)?.enabled) {
    return call(request, opts, autoKey)
  }

  return call(request, {
    ...opts,
    key: () => toValue(opts.key) || asyncDataKeyFor(request, opts),
    $fetch: createPreFetchFetch(nuxtApp, opts.$fetch),
  }, autoKey)
}) as typeof UseFetch
