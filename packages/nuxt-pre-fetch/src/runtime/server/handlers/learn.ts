import type { EventHandler } from 'h3'
import { createError, defineEventHandler, getRequestHeader, readBody, setResponseHeaders, setResponseStatus } from 'h3'
import { useRuntimeConfig } from 'nitropack/runtime'
import type { LearnedRequest, PrivateRuntimeOptions, PublicRuntimeOptions } from '../../shared/types'
import { INTERNAL_HEADER } from '../../shared/identity'
import { isVisitId, normalizeLearnPath, sanitizeLearnedRequest } from '../utils/learned'
import { ensureBrowserId, writeLearnedPage } from '../utils/learned-store'

const MAX_BODY_BYTES = 256 * 1024

/**
 * `POST <endpoint>/learn` `{ path, visit, requests: LearnedRequest[] }` — the browser reports
 * the GET requests a page sent so Nitro can replay them on the next visit. Same-origin only;
 * every request is validated (allowed hosts, header allow-list, auth cookie allow-list) and
 * stored for THIS browser only. Nothing is fetched here.
 */
const handler: EventHandler = defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'private, no-store' })
  const config = useRuntimeConfig(event) as unknown as { nuxtPreFetch: PrivateRuntimeOptions, public: { nuxtPreFetch: PublicRuntimeOptions } }
  const options = { ...config.nuxtPreFetch.dynamic, ...config.nuxtPreFetch.learn }
  if (!config.public.nuxtPreFetch?.enabled || !config.public.nuxtPreFetch.learn || !config.nuxtPreFetch.learn?.enabled) {
    throw createError({ statusCode: 404, statusMessage: 'Learning is disabled' })
  }
  if (getRequestHeader(event, INTERNAL_HEADER)) throw createError({ statusCode: 400, statusMessage: 'Recursive prefetch request' })
  // Browsers send Sec-Fetch-Site; anything but our own pages may not write here.
  const site = getRequestHeader(event, 'sec-fetch-site')
  if (site && site !== 'same-origin') throw createError({ statusCode: 403, statusMessage: 'Cross-site learn request' })
  const length = Number(getRequestHeader(event, 'content-length') ?? 0)
  if (length > MAX_BODY_BYTES) throw createError({ statusCode: 413, statusMessage: 'Body too large' })

  let body: unknown = await readBody(event)
  if (typeof body === 'string') {
    // `navigator.sendBeacon` posts text/plain.
    if (body.length > MAX_BODY_BYTES) throw createError({ statusCode: 413, statusMessage: 'Body too large' })
    try {
      body = JSON.parse(body)
    }
    catch {
      throw createError({ statusCode: 400, statusMessage: 'Invalid JSON' })
    }
  }
  const { path: rawPath, visit, requests } = (body ?? {}) as { path?: unknown, visit?: unknown, requests?: unknown }
  const path = normalizeLearnPath(rawPath)
  if (!path) throw createError({ statusCode: 400, statusMessage: 'Invalid path' })
  if (!isVisitId(visit)) throw createError({ statusCode: 400, statusMessage: 'Invalid visit' })
  if (!Array.isArray(requests) || requests.length > options.maxRequestsPerPage) throw createError({ statusCode: 400, statusMessage: 'Invalid requests' })

  const accepted: LearnedRequest[] = []
  const rejected: string[] = []
  for (const input of requests) {
    const result = sanitizeLearnedRequest(input, options)
    if (result.ok) accepted.push(result.request)
    else rejected.push(result.reason)
  }
  if (config.public.nuxtPreFetch.debug && rejected.length) {
    console.debug(`[nuxt-pre-fetch] learn ${path}: rejected ${rejected.length} request(s): ${[...new Set(rejected)].join('; ')}`)
  }

  const browserId = ensureBrowserId(event, options)
  if (accepted.length) await writeLearnedPage(browserId, path, visit, accepted, options)
  setResponseStatus(event, 200)
  return { accepted: accepted.length, rejected: rejected.length }
})

export default handler
