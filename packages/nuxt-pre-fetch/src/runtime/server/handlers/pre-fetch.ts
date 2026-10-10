import type { EventHandler } from 'h3'
import { appendResponseHeader, createError, defineEventHandler, getQuery, getRequestHeader, setResponseHeaders } from 'h3'
import type { PayloadEntry, PayloadFailure } from '../../shared/types'
import { INTERNAL_HEADER, PAYLOAD_VERSION } from '../../shared/identity'
import { executePrefetch, planPrefetch, runPrefetch, serverTiming } from '../utils/runner'

/** One line of the streamed (`?stream=1`) response. */
export type PrefetchStreamLine =
  | { v: 1, path: string, runtime?: string[] } // first line
  | { id: string, entry: PayloadEntry } // one per finished request, in completion order
  | { id: string, failed: PayloadFailure } // a request that failed here: the browser retries it now
  | { done: true, ms: number } // last line

/**
 * `GET <endpoint>?path=/users/2?tab=a[&id=<request id>][&skipStores=a,b][&stream=1]` — runs
 * the manifest requests of an app route for client navigation and `fetchMode: 'server'`
 * refreshes, plus the page's runtime requests (definePrefetch, learned). Only requests discovered
 * at build time, declared or learned (validated against `dynamic.allowedHosts`) can ever run here: the
 * caller picks a route, never a URL. Authorisation is enforced by the target APIs, which
 * receive this request's cookies/headers (runtime requests: the bearer cookie they name).
 *
 * `stream=1` answers NDJSON: each result is sent the moment its request finishes, so the
 * browser can render it before the slowest request is done (client navigation).
 */
const handler: EventHandler = defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'private, no-store', 'vary': 'cookie' })
  if (getRequestHeader(event, INTERNAL_HEADER)) {
    throw createError({ statusCode: 400, statusMessage: 'Recursive prefetch request' })
  }
  const { path, id, skipStores, stream } = getQuery(event)
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 2048) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid path' })
  }
  if (id !== undefined && (typeof id !== 'string' || !/^[\da-f]{16}$/.test(id))) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  }
  if (skipStores !== undefined && (typeof skipStores !== 'string' || !/^[\w.:@/-]{1,200}(?:,[\w.:@/-]{1,200}){0,99}$/.test(skipStores))) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid skipStores' })
  }
  const options = { only: id as string | undefined, skipStores: skipStores ? skipStores.split(',') : undefined }
  const startedAt = performance.now()

  if (stream === '1' && !options.only) {
    // Decided before the first byte: a stream can't turn into a 404 later.
    const plan = await planPrefetch(event, path, options)
    if (!plan) throw createError({ statusCode: 404, statusMessage: 'No prefetchable route' })
    setResponseHeaders(event, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-accel-buffering': 'no', // no proxy buffering: lines must reach the browser as they are written
      // Sent with the headers, so without a duration: the total is the `done` line's `ms`.
      'server-timing': 'nuxt-pre-fetch;desc="usePreFetch (streamed)"',
    })
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (line: PrefetchStreamLine) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        // `runtime`: ids of runtime requests that may still arrive — the browser waits for those.
        write(plan.runtime.length ? { v: PAYLOAD_VERSION, path, runtime: plan.runtime.map(r => r.id) } : { v: PAYLOAD_VERSION, path })
        try {
          await executePrefetch(event, plan, {
            ...options,
            onEntry: (entryId, entry) => write({ id: entryId, entry }),
            onFailure: (entryId, failed) => write({ id: entryId, failed }),
          })
        }
        finally {
          write({ done: true, ms: Math.round(performance.now() - startedAt) })
          controller.close()
        }
      },
    })
  }

  const payload = await runPrefetch(event, path, options)
  if (payload) appendResponseHeader(event, 'server-timing', serverTiming(performance.now() - startedAt, Object.keys(payload.entries).length))
  if (!payload) throw createError({ statusCode: 404, statusMessage: 'No prefetchable route' })
  return payload
})

export default handler
