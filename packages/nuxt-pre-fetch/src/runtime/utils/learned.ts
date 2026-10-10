import type { NuxtApp } from 'nuxt/app'
import type { LearnedRequest, PayloadEntry, PayloadFailure } from '../shared/types'
import type { NormalizedQuery } from '../shared/identity'
import { normalizeQuery, requestIdentity } from '../shared/identity'

/**
 * Learned results of the current page (see the `learn` module option). Unlike manifest
 * entries they stay available after the page rendered — libraries that build their
 * requests at runtime typically fire them from `onMounted` — until each is consumed once,
 * the app navigates to another page, or `ttl` passes.
 */
export interface LearnedBucket {
  /** App full path (no hash) the bucket belongs to. */
  path: string | null
  entries: Map<string, PayloadEntry>
  /** Ids that may still arrive (streamed navigation prefetch). */
  expected: Set<string>
  /** Lookups waiting for an expected id. */
  waiters: Map<string, Array<() => void>>
  /** Epoch ms after which nothing is served. */
  expiresAt: number
  generation: number
  /** App paths this browser has learned requests for. */
  paths: Set<string>
  /** Requests that failed on the server: the caller retries them in the browser. */
  failed: Map<string, PayloadFailure>
}

/** How long learned results stay usable after they arrived, in ms. */
export const LEARNED_TTL = 60_000

const BUCKET_KEY = '~nuxtPreFetchLearned'

export function useLearnedBucket(nuxtApp: NuxtApp): LearnedBucket {
  const app = nuxtApp as NuxtApp & { [BUCKET_KEY]?: LearnedBucket }
  app[BUCKET_KEY] ??= { path: null, entries: new Map(), expected: new Set(), waiters: new Map(), expiresAt: 0, generation: 0, paths: new Set(), failed: new Map() }
  return app[BUCKET_KEY]
}

function release(bucket: LearnedBucket, id?: string): void {
  const lists = id === undefined ? [...bucket.waiters.values()] : [bucket.waiters.get(id) ?? []]
  if (id === undefined) bucket.waiters.clear()
  else bucket.waiters.delete(id)
  for (const list of lists) for (const resolve of list) resolve()
}

/** A new page: drop everything learned for the previous one. */
export function resetLearned(bucket: LearnedBucket, path: string | null, now: number = Date.now()): void {
  bucket.generation++
  bucket.path = path
  bucket.entries.clear()
  bucket.expected.clear()
  bucket.failed.clear()
  bucket.expiresAt = now + LEARNED_TTL
  release(bucket)
}

/** Results that arrived (HTML payload or one streamed line). */
export function addLearned(bucket: LearnedBucket, id: string, entry: PayloadEntry): void {
  // Only successes are served: on an error the library's own request (and its error
  // handling, e.g. a token refresh) runs instead.
  if ('d' in entry) bucket.entries.set(id, entry)
  bucket.expected.delete(id)
  release(bucket, id)
}

/** A runtime request failed on the server: stop waiting for it; the caller fetches it itself. */
export function failLearned(bucket: LearnedBucket, id: string, failure: PayloadFailure): void {
  bucket.failed.set(id, failure)
  bucket.entries.delete(id)
  bucket.expected.delete(id)
  release(bucket, id)
}

/** Ids announced by a streamed navigation prefetch (they may arrive later). */
export function expectLearned(bucket: LearnedBucket, ids: string[]): void {
  for (const id of ids) bucket.expected.add(id)
}

/** The stream ended: stop waiting for ids that never came. */
export function endLearned(bucket: LearnedBucket): void {
  bucket.expected.clear()
  release(bucket)
}

export function learnedIdentity(method: string, url: string, query?: Record<string, unknown> | null): string {
  return requestIdentity(method, url, normalizeQuery(query) as NormalizedQuery)
}

/** Synchronous: is a learned result available (or still arriving) for this request? */
export function expectsLearned(bucket: LearnedBucket, id: string, now: number = Date.now()): boolean {
  if (now > bucket.expiresAt) return false
  return bucket.entries.has(id) || bucket.expected.has(id)
}

/**
 * Takes the learned result of a request, once. Waits for an expected id that is still
 * streaming. `undefined` = not available: the caller fetches itself.
 */
export async function takeLearned(bucket: LearnedBucket, id: string, now: number = Date.now()): Promise<{ data: unknown } | undefined> {
  if (!expectsLearned(bucket, id, now)) return undefined
  if (!bucket.entries.has(id)) {
    const generation = bucket.generation
    await new Promise<void>((resolve) => {
      const list = bucket.waiters.get(id) ?? []
      list.push(resolve)
      bucket.waiters.set(id, list)
    })
    if (bucket.generation !== generation) return undefined
  }
  const entry = bucket.entries.get(id)
  if (!entry || !('d' in entry)) return undefined
  bucket.entries.delete(id)
  return { data: entry.d }
}

/**
 * Collects the requests a page reports and posts them to `<endpoint>/learn`, once the
 * page has been quiet for `delay` ms, and right away (beacon) when it is left.
 */
export interface LearnQueue {
  add: (path: string, request: LearnedRequest) => void
  /** Sends what is queued (navigation away / page hide). */
  flush: (beacon?: boolean) => void
}

export function createLearnQueue(send: (body: string, beacon: boolean) => void, delay: number = 1500, maxPerPage: number = 40): LearnQueue {
  let path: string | null = null
  let visit = newVisitId()
  let queued: LearnedRequest[] = []
  let sentForPage = 0
  const seen = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (beacon = false) => {
    clearTimeout(timer)
    timer = undefined
    if (!path || !queued.length) return
    const body = JSON.stringify({ path, visit, requests: queued })
    sentForPage += queued.length
    queued = []
    send(body, beacon)
  }

  return {
    add(nextPath, request) {
      if (nextPath !== path) {
        // A new page visit: send what the previous one collected, start a new visit.
        flush()
        path = nextPath
        visit = newVisitId()
        seen.clear()
        sentForPage = 0
      }
      const id = learnedIdentity('GET', request.url, request.query)
      if (seen.has(id) || sentForPage + queued.length >= maxPerPage) return
      seen.add(id)
      queued.push(request)
      clearTimeout(timer)
      timer = setTimeout(() => flush(), delay)
    },
    flush,
  }
}

function newVisitId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
