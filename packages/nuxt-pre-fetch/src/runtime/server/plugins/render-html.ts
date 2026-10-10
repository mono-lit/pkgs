import type { NitroAppPlugin } from 'nitropack/types'
import { appendResponseHeader, getRequestHeader, setResponseHeader } from 'h3'
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { INTERNAL_HEADER, PAYLOAD_ELEMENT_ID, PAYLOAD_VERSION } from '../../shared/identity'
import type { PrefetchPayload, PrivateRuntimeOptions, PublicRuntimeOptions } from '../../shared/types'
import { escapeAttribute, serializeForHTML } from '../utils/serialize'
import { withoutBase } from '../utils/resolve'
import { runPrefetch, serverTiming } from '../utils/runner'
import { ensureBrowserId, readLearnedPaths } from '../utils/learned-store'

/**
 * Initial load: with `ssr: false` Nuxt still renders the SPA shell per request
 * through its renderer, which calls `render:html` (verified on
 * @nuxt/nitro-server 4.5). The route's manifest requests (and this browser's learned
 * requests for the page) run here and their results are embedded as `application/json`
 * (never executed).
 */
const plugin: NitroAppPlugin = defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:html', async (html, { event }) => {
    if (event.method !== 'GET') return
    if (getRequestHeader(event, INTERNAL_HEADER)) return // a prefetched URL rendered a page: no recursion
    if (event.path.startsWith('/__nuxt_error')) return

    const config = useRuntimeConfig(event) as unknown as { app: { baseURL: string }, nuxtPreFetch: PrivateRuntimeOptions, public: { nuxtPreFetch: PublicRuntimeOptions } }
    const path = withoutBase(event.path, config.app.baseURL)
    if (!path || !config.public.nuxtPreFetch?.enabled) return

    // Learning: every page response carries this browser's id cookie, and the payload lists
    // the pages it has learned (client navigation prefetches those too).
    const learning = !!config.public.nuxtPreFetch.learn && !!config.nuxtPreFetch.learn?.enabled
    let paths: string[] = []
    if (learning) {
      const learnOptions = { ...config.nuxtPreFetch.dynamic, ...config.nuxtPreFetch.learn }
      const browserId = ensureBrowserId(event, learnOptions)
      paths = await readLearnedPaths(browserId, learnOptions)
    }

    const startedAt = performance.now()
    let payload: PrefetchPayload | null = await runPrefetch(event, path)
    if (payload) {
      // Standard Server-Timing: how long the HTML waited for the prefetch (visible in
      // DevTools and to scripts via PerformanceNavigationTiming.serverTiming).
      appendResponseHeader(event, 'server-timing', serverTiming(performance.now() - startedAt, Object.keys(payload.entries).length))
    }
    if (paths.length) payload = { ...(payload ?? { v: PAYLOAD_VERSION, path, entries: {} }), paths }
    if (!payload || (Object.keys(payload.entries).length === 0 && !payload.paths && !payload.planned && !payload.failed)) return

    html.head.push(
      `<script type="application/json" id="${PAYLOAD_ELEMENT_ID}" data-path="${escapeAttribute(path)}">${serializeForHTML(payload)}</script>`,
    )
    // The document now carries per-user data: never let a shared cache store it.
    setResponseHeader(event, 'cache-control', 'private, no-store')
    appendResponseHeader(event, 'vary', 'cookie')
  })
})

export default plugin
