import type { NuxtApp } from 'nuxt/app'
import type { PayloadEntry, PayloadFailure, PrefetchPayload } from '../shared/types'
import { PAYLOAD_VERSION } from '../shared/identity'

/**
 * Per-app (= per browser tab) store of prefetched results for the page that is
 * currently being set up. It is filled from the HTML payload on first load and
 * from the prefetch endpoint on client navigation, and closed once the page has
 * rendered, so a later `refresh()` or remount never reads stale prefetched data.
 */
export interface PreFetchStore {
  /** Route full path the current entries belong to. */
  path: string | null
  entries: Map<string, PayloadEntry>
  /** In-flight navigation prefetch; lookups wait for it. */
  pending: Promise<void> | null
  /** Bumped on every navigation; late responses of older generations are dropped. */
  generation: number
  /** False once the page has rendered: lookups miss from then on. */
  open: boolean
  controller: AbortController | null
  initialized: boolean
  /** A streamed navigation prefetch is still delivering entries (`?stream=1`). */
  streaming: boolean
  /** Lookups waiting for an entry that hasn't streamed in yet (resolved on arrival or stream end). */
  waiters: Map<string, Array<() => void>>
  /** The page asked to close while streaming: close once the stream ends. */
  closeAfterStream: boolean
  /** Requests that failed on the server: never served, the caller retries them in the browser. */
  failed: Map<string, PayloadFailure>
}

const STORE_KEY = '~nuxtPreFetch'

export function usePreFetchStore(nuxtApp: NuxtApp): PreFetchStore {
  const app = nuxtApp as NuxtApp & { [STORE_KEY]?: PreFetchStore }
  app[STORE_KEY] ??= {
    path: null,
    entries: new Map(),
    pending: null,
    generation: 0,
    open: false,
    controller: null,
    initialized: false,
    streaming: false,
    waiters: new Map(),
    closeAfterStream: false,
    failed: new Map(),
  }
  return app[STORE_KEY]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validates an untrusted payload (HTML text or endpoint response). Returns
 * `null` for anything malformed instead of throwing.
 */
export function parsePayload(input: unknown): PrefetchPayload | null {
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    }
    catch {
      return null
    }
  }
  if (!isPlainObject(value) || value.v !== PAYLOAD_VERSION || typeof value.path !== 'string' || !isPlainObject(value.entries)) return null
  const entries: Record<string, PayloadEntry> = {}
  for (const [id, entry] of Object.entries(value.entries)) {
    const parsed = parseEntry(entry)
    if (parsed) entries[id] = parsed
  }
  const payload: PrefetchPayload = { v: PAYLOAD_VERSION, path: value.path, entries }
  const failed = parseFailures(value.failed)
  if (failed) payload.failed = failed
  const runtime = stringList(value.runtime)
  const paths = stringList(value.paths)
  if (runtime) payload.runtime = runtime
  if (paths) payload.paths = paths
  const planned = stringList(value.planned)
  if (planned) payload.planned = planned
  return payload
}

/** Validates an untrusted `failed` map; `undefined` when absent/empty. */
export function parseFailures(value: unknown): Record<string, PayloadFailure> | undefined {
  if (!isPlainObject(value)) return undefined
  const out: Record<string, PayloadFailure> = {}
  for (const [id, failure] of Object.entries(value)) {
    const parsed = parseFailure(failure)
    if (parsed) out[id] = parsed
  }
  return Object.keys(out).length ? out : undefined
}

export function parseFailure(value: unknown): PayloadFailure | null {
  if (!isPlainObject(value)) return null
  const reason = value.r
  if (reason !== 'http' && reason !== 'timeout' && reason !== 'network' && reason !== 'size') return null
  return typeof value.s === 'number' ? { s: value.s, r: reason } : { r: reason }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined
}

/** Validates one untrusted entry; `null` when malformed. */
export function parseEntry(entry: unknown): PayloadEntry | null {
  if (!isPlainObject(entry)) return null
  if ('e' in entry) {
    const error = entry.e
    if (!isPlainObject(error) || typeof error.s !== 'number') return null
    return { e: { s: error.s, m: typeof error.m === 'string' ? error.m : undefined, d: error.d } }
  }
  // `{}` (no `d`) is a valid entry whose response body was empty (`undefined`).
  return { d: entry.d }
}

function releaseWaiters(store: PreFetchStore, id?: string): void {
  const lists = id === undefined ? [...store.waiters.values()] : [store.waiters.get(id) ?? []]
  if (id === undefined) store.waiters.clear()
  else store.waiters.delete(id)
  for (const list of lists) for (const resolve of list) resolve()
}

/** Drops current entries and aborts an in-flight navigation prefetch. */
export function resetStore(store: PreFetchStore): void {
  store.generation++
  store.controller?.abort()
  store.controller = null
  store.pending = null
  store.entries.clear()
  store.path = null
  store.open = false
  store.streaming = false
  store.closeAfterStream = false
  store.failed.clear()
  releaseWaiters(store)
}

export function fillStore(store: PreFetchStore, payload: PrefetchPayload): void {
  store.entries = new Map(Object.entries(payload.entries))
  store.failed = new Map(Object.entries(payload.failed ?? {}))
  store.path = payload.path
  store.open = true
}

/** A streamed navigation prefetch started: entries arrive one by one (`addEntry`). */
export function beginStream(store: PreFetchStore, path: string): void {
  store.entries = new Map()
  store.failed = new Map()
  store.path = path
  store.open = true
  store.streaming = true
  store.closeAfterStream = false
}

/** One streamed result arrived: hand it to the lookups waiting for it. */
export function addEntry(store: PreFetchStore, id: string, entry: PayloadEntry): void {
  store.entries.set(id, entry)
  releaseWaiters(store, id)
}

/** A streamed request failed on the server: its lookups stop waiting and fetch themselves now. */
export function addFailure(store: PreFetchStore, id: string, failure: PayloadFailure): void {
  store.failed.set(id, failure)
  releaseWaiters(store, id)
}

/** The stream ended: lookups still waiting get nothing (they fetch themselves). */
export function endStream(store: PreFetchStore): void {
  store.streaming = false
  releaseWaiters(store)
  if (store.closeAfterStream) {
    store.closeAfterStream = false
    store.open = false
    store.entries.clear()
  }
}

/**
 * Closes the store once the page has rendered (waits for an in-flight prefetch, and for
 * a stream to end so components still waiting for their entry get it).
 */
export function closeStore(store: PreFetchStore): void {
  const generation = store.generation
  const close = () => {
    if (store.generation !== generation) return
    if (store.streaming) {
      store.closeAfterStream = true
      return
    }
    store.open = false
    store.entries.clear()
  }
  if (store.pending) store.pending.then(close, close)
  else close()
}

/**
 * Looks up a prefetched result. `undefined` = not prefetched (the caller must
 * fetch); an entry with `d: null | false | 0 | []` is real data.
 */
export async function takeEntry(store: PreFetchStore, id: string): Promise<PayloadEntry | undefined> {
  if (store.pending) await store.pending
  if (!store.open) return undefined
  if (store.failed.has(id)) return undefined
  if (!store.entries.has(id) && store.streaming) {
    // Streamed navigation prefetch: wait for THIS entry (or the end of the stream).
    const generation = store.generation
    await new Promise<void>((resolve) => {
      const list = store.waiters.get(id) ?? []
      list.push(resolve)
      store.waiters.set(id, list)
    })
    if (store.generation !== generation || !store.open) return undefined
  }
  return store.entries.get(id)
}
