import { afterEach, describe, expect, it, vi } from 'vitest'
import { addEntry, addFailure, beginStream, closeStore, endStream, fillStore, parsePayload, resetStore, takeEntry, usePreFetchStore } from '../../src/runtime/utils/store'
import { expectLearned, expectsLearned, failLearned, resetLearned, takeLearned, useLearnedBucket } from '../../src/runtime/utils/learned'
import { createPreFetchFetch } from '../../src/runtime/utils/fetch'
import { requestIdentity } from '../../src/runtime/shared/identity'

function createApp(publicOptions: Record<string, unknown> = {}) {
  return {
    $config: {
      public: {
        nuxtPreFetch: { enabled: true, debug: false, fetchMode: 'client', fallback: 'client', endpoint: '/__nuxt_pre_fetch', ...publicOptions },
      },
    },
    $router: { currentRoute: { value: { fullPath: '/page?x=1' } } },
  } as any
}

const id = (url: string, query = {}) => requestIdentity('GET', url, query)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parsePayload', () => {
  it('accepts valid payloads and keeps falsy data', () => {
    const payload = parsePayload(JSON.stringify({ v: 1, path: '/p', entries: { a: { d: null }, b: { d: 0 }, c: {}, e: { e: { s: 404, m: 'x' } } } }))
    expect(payload!.entries).toEqual({ a: { d: null }, b: { d: 0 }, c: { d: undefined }, e: { e: { s: 404, m: 'x', d: undefined } } })
  })

  it.each([
    '{not json',
    'null',
    '[]',
    JSON.stringify({ v: 2, path: '/', entries: {} }),
    JSON.stringify({ v: 1, path: 1, entries: {} }),
    JSON.stringify({ v: 1, path: '/', entries: [] }),
  ])('rejects %s', (text) => {
    expect(parsePayload(text)).toBeNull()
  })

  it('drops malformed entries only', () => {
    expect(parsePayload({ v: 1, path: '/', entries: { a: 1, b: { e: { s: 'x' } }, c: { d: 1 } } })!.entries).toEqual({ c: { d: 1 } })
  })
})

describe('store lifecycle', () => {
  it('streaming: a lookup waits for ITS entry only, and gets nothing once the stream ends without it', async () => {
    const store = usePreFetchStore(createApp())
    beginStream(store, '/team')
    const order: string[] = []
    const a = takeEntry(store, 'a').then((entry) => { order.push('a'); return entry })
    const b = takeEntry(store, 'b').then((entry) => { order.push('b'); return entry })
    const missing = takeEntry(store, 'missing').then((entry) => { order.push('missing'); return entry })
    addEntry(store, 'b', { d: 'B' }) // completion order, not request order
    expect(await b).toEqual({ d: 'B' })
    expect(order).toEqual(['b'])
    addEntry(store, 'a', { d: null })
    expect(await a).toEqual({ d: null })
    endStream(store)
    expect(await missing).toBeUndefined()
    expect(order).toEqual(['b', 'a', 'missing'])
    expect(await takeEntry(store, 'a')).toEqual({ d: null }) // already there: no waiting
  })

  it('streaming: closing mid-stream is deferred until the stream ends; a new navigation releases waiters', async () => {
    const store = usePreFetchStore(createApp())
    beginStream(store, '/team')
    const late = takeEntry(store, 'late')
    closeStore(store) // the page rendered (lazy calls still waiting)
    expect(store.open).toBe(true)
    addEntry(store, 'late', { d: 1 })
    expect(await late).toEqual({ d: 1 })
    endStream(store)
    expect(store.open).toBe(false)

    beginStream(store, '/next')
    const abandoned = takeEntry(store, 'x')
    resetStore(store)
    expect(await abandoned).toBeUndefined()
  })

  it('serves entries until closed, and waits for a pending navigation prefetch', async () => {
    const store = usePreFetchStore(createApp())
    let release!: () => void
    store.pending = new Promise<void>((resolve) => {
      release = () => {
        fillStore(store, { v: 1, path: '/p', entries: { a: { d: 1 } } })
        resolve()
      }
    })
    const lookup = takeEntry(store, 'a')
    release()
    expect(await lookup).toEqual({ d: 1 })
    store.pending = null
    closeStore(store)
    expect(await takeEntry(store, 'a')).toBeUndefined()
  })

  it('reset drops entries and aborts the in-flight request', () => {
    const store = usePreFetchStore(createApp())
    const controller = new AbortController()
    store.controller = controller
    fillStore(store, { v: 1, path: '/p', entries: { a: { d: 1 } } })
    resetStore(store)
    expect(controller.signal.aborted).toBe(true)
    expect(store.entries.size).toBe(0)
    expect(store.open).toBe(false)
  })
})

describe('createPreFetchFetch', () => {
  it('serves a prefetched result once per composable, then fetches', async () => {
    const app = createApp()
    fillStore(usePreFetchStore(app), { v: 1, path: '/page', entries: { [id('/api/a', { q: '1' })]: { d: null } } })
    const base = vi.fn(async () => 'network')
    const fetcher = createPreFetchFetch(app, base as any)
    expect(await fetcher('/api/a', { query: { q: 1 } })).toBeNull()
    expect(base).not.toHaveBeenCalled()
    expect(await fetcher('/api/a', { query: { q: 1 } })).toBe('network') // refresh()
    // A second composable with the same request on the same page also gets the prefetched value.
    expect(await createPreFetchFetch(app, base as any)('/api/a', { query: { q: 1 } })).toBeNull()
  })

  it('rethrows a prefetched HTTP error', async () => {
    const app = createApp()
    fillStore(usePreFetchStore(app), { v: 1, path: '/page', entries: { [id('/api/e')]: { e: { s: 403, m: 'Forbidden', d: { r: 1 } } } } })
    await expect(createPreFetchFetch(app, vi.fn())('/api/e')).rejects.toMatchObject({ statusCode: 403, data: { r: 1 } })
  })

  it('in server mode refreshes through the endpoint, never calling the API from the browser', async () => {
    const app = createApp({ fetchMode: 'server' })
    const base = vi.fn(async (url: string, init?: any) => {
      expect(url).toBe('/__nuxt_pre_fetch')
      return { v: 1, path: init.query.path, entries: { [init.query.id]: { d: 'from-nitro' } } }
    })
    const result = await createPreFetchFetch(app, base as any)('/api/a')
    expect(result).toBe('from-nitro')
    expect(base).toHaveBeenCalledWith('/__nuxt_pre_fetch', expect.objectContaining({ query: { path: '/page?x=1', id: id('/api/a') } }))
  })

  it('in server mode falls back per `fallback` for requests Nitro does not know', async () => {
    const notFound = async (url: string) => (url === '/__nuxt_pre_fetch' ? { statusCode: 404 } : 'browser')
    expect(await createPreFetchFetch(createApp({ fetchMode: 'server' }), vi.fn(notFound) as any)('/api/x')).toBe('browser')
    await expect(createPreFetchFetch(createApp({ fetchMode: 'server', fallback: 'error' }), vi.fn(notFound) as any)('/api/x'))
      .rejects.toMatchObject({ statusCode: 501 })
  })

  it('retries a request that failed on the server from the browser (even in server mode)', async () => {
    for (const fetchMode of ['client', 'server']) {
      const app = createApp({ fetchMode })
      fillStore(usePreFetchStore(app), { v: 1, path: '/page', entries: {}, failed: { [id('/api/e')]: { s: 503, r: 'http' } } })
      const base = vi.fn(async () => 'browser-retry')
      expect(await createPreFetchFetch(app, base as any)('/api/e')).toBe('browser-retry')
      expect(base).toHaveBeenCalledWith('/api/e', {})
    }
  })

  it('a streamed failure releases the waiting lookup at once (no wait for the end of the stream)', async () => {
    const store = usePreFetchStore(createApp())
    beginStream(store, '/page')
    let settled = false
    const pending = takeEntry(store, 'slow').then((entry) => {
      settled = true
      return entry
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    addFailure(store, 'slow', { r: 'timeout' })
    expect(await pending).toBeUndefined()
    expect(store.streaming).toBe(true) // the stream itself is still running
  })

  it('parses failures from the payload and drops malformed ones', () => {
    const payload = parsePayload({ v: 1, path: '/', entries: {}, failed: { a: { s: 401, r: 'http' }, b: { r: 'timeout' }, c: { r: 'nope' }, d: 1 } })
    expect(payload!.failed).toEqual({ a: { s: 401, r: 'http' }, b: { r: 'timeout' } })
  })

  it('runtime results: a failed id is not expected and wakes its waiter', async () => {
    const bucket = useLearnedBucket(createApp())
    resetLearned(bucket, '/home')
    expectLearned(bucket, ['x'])
    const pending = takeLearned(bucket, 'x')
    failLearned(bucket, 'x', { s: 500, r: 'http' })
    expect(await pending).toBeUndefined()
    expect(expectsLearned(bucket, 'x')).toBe(false)
    expect(bucket.failed.get('x')).toEqual({ s: 500, r: 'http' })
  })

  it('passes non-GET requests straight through', async () => {
    const app = createApp()
    const base = vi.fn(async () => 'posted')
    expect(await createPreFetchFetch(app, base as any)('/api/a', { method: 'POST', body: {} })).toBe('posted')
  })
})
