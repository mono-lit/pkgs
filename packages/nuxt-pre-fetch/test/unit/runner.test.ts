import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeState } from './stubs/imports'
import { manifest } from './stubs/manifest'
import { compileRoutePath } from '../../src/build/routes'
import { runPrefetch, serverTiming } from '../../src/runtime/server/utils/runner'
import { requestIdentity } from '../../src/runtime/shared/identity'
import type { ManifestRequest } from '../../src/runtime/shared/types'

function route(pattern: string, requests: Array<Omit<ManifestRequest, 'source'>>) {
  const compiled = compileRoutePath(pattern)!
  return { pattern, re: compiled.re, params: compiled.params, requests: requests.map((r, i) => ({ ...r, source: `${pattern}#${i}` })) }
}

function createEvent(headers: Record<string, string> = {}, handler?: (url: string, init: any) => unknown) {
  const calls: Array<{ url: string, init: any }> = []
  const event = {
    headers,
    node: { req: { headers } },
    $fetch: async (url: string, init: any) => {
      calls.push({ url, init })
      return handler ? handler(url, init) : { url, query: init.query }
    },
  }
  return { event: event as any, calls }
}

beforeEach(() => {
  manifest.routes = [
    route('/dashboard', [{ url: ['/api/users'] }, { url: ['/api/products'] }, { url: ['/api/users'] }]),
    route('/users/:id()', [{ url: ['/api/users/', { p: 'id' }], query: { tab: { rq: 'tab' } } }]),
    route('/ext', [{ url: ['https://api.example.com/items'] }, { url: ['https://evil.example.org/x'] }]),
  ]
  runtimeState.hooks = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runPrefetch', () => {
  it('returns null for routes without prefetchable requests', async () => {
    const { event } = createEvent()
    expect(await runPrefetch(event, '/nope')).toBeNull()
  })

  it('runs each distinct request once, through event.$fetch with the loop-guard header', async () => {
    const { event, calls } = createEvent()
    const payload = await runPrefetch(event, '/dashboard')
    expect(calls.map(c => c.url)).toEqual(['/api/users', '/api/products'])
    expect(calls[0]!.init.headers['x-nuxt-pre-fetch']).toBe('1')
    expect(Object.keys(payload!.entries)).toEqual([
      requestIdentity('GET', '/api/users'),
      requestIdentity('GET', '/api/products'),
    ])
  })

  it('resolves route params and query, keyed by the client identity', async () => {
    const { event, calls } = createEvent()
    const payload = await runPrefetch(event, '/users/7?tab=posts')
    expect(calls).toEqual([{ url: '/api/users/7', init: expect.objectContaining({ query: { tab: 'posts' } }) }])
    expect(payload!.path).toBe('/users/7?tab=posts')
    expect(payload!.entries[requestIdentity('GET', '/api/users/7', { tab: 'posts' })]).toBeDefined()
  })

  it('keeps falsy data and empty bodies as data', async () => {
    const values = [null, false, 0, [], undefined]
    let i = 0
    manifest.routes = [route('/x', values.map((_, n) => ({ url: [`/api/v${n}`] })))]
    const { event } = createEvent({}, () => values[i++])
    const payload = await runPrefetch(event, '/x')
    expect(Object.values(payload!.entries)).toEqual([{ d: null }, { d: false }, { d: 0 }, { d: [] }, { d: undefined }])
  })

  const failingRoutes = () => {
    manifest.routes = [route('/e', [{ url: ['/api/403'] }, { url: ['/api/500'] }, { url: ['/api/net'] }, { url: ['/api/slow'] }])]
    return createEvent({}, (url) => {
      if (url === '/api/403') throw Object.assign(new Error('x'), { statusCode: 403, statusMessage: 'Forbidden', data: { reason: 'no', url: 'http://internal', stack: 's' } })
      if (url === '/api/500') throw Object.assign(new Error('x'), { statusCode: 500 })
      if (url === '/api/slow') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      throw new TypeError('fetch failed')
    }).event
  }

  it('reports every server failure (status / reason) so the browser retries it itself', async () => {
    const failures: Array<[string, unknown]> = []
    const payload = await runPrefetch(failingRoutes(), '/e', { onFailure: (id, failure) => failures.push([id, failure]) })
    expect(payload!.entries).toEqual({})
    expect(payload!.failed).toEqual({
      [requestIdentity('GET', '/api/403')]: { s: 403, r: 'http' },
      [requestIdentity('GET', '/api/500')]: { s: 500, r: 'http' },
      [requestIdentity('GET', '/api/net')]: { r: 'network' },
      [requestIdentity('GET', '/api/slow')]: { r: 'timeout' },
    })
    expect(failures).toHaveLength(4)
  })

  it('`serverErrors: \'embed\'`: a 4xx is embedded as the error (no server details); the rest is retried', async () => {
    runtimeState.config.public.nuxtPreFetch.serverErrors = 'embed'
    try {
      const payload = await runPrefetch(failingRoutes(), '/e')
      expect(payload!.entries).toEqual({
        [requestIdentity('GET', '/api/403')]: { e: { s: 403, m: 'Forbidden', d: { reason: 'no' } } },
      })
      expect(Object.keys(payload!.failed!)).toHaveLength(3)
    }
    finally {
      delete runtimeState.config.public.nuxtPreFetch.serverErrors
    }
  })

  it('only calls allowed external hosts, forwarding only the configured headers', async () => {
    const globalFetch = vi.fn(async () => ['item'])
    vi.stubGlobal('$fetch', globalFetch)
    const { event, calls } = createEvent({ authorization: 'Bearer t', cookie: 'secret=1' })
    const payload = await runPrefetch(event, '/ext')
    expect(calls).toEqual([])
    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect(globalFetch.mock.calls[0]).toEqual(['https://api.example.com/items', expect.objectContaining({ headers: { authorization: 'Bearer t' } })])
    expect(Object.keys(payload!.entries)).toHaveLength(1)
  })

  it('applies pick on the server to plain objects, merging the keys of duplicated requests', async () => {
    manifest.routes = [route('/p', [
      { url: ['/api/a'], pick: ['id'] },
      { url: ['/api/a'], pick: ['name'] },
      { url: ['/api/list'], pick: ['id'] },
      { url: ['/api/full'], pick: ['id'] },
      { url: ['/api/full'] },
    ])]
    const { event, calls } = createEvent({}, url => (url === '/api/list' ? [{ id: 1, x: 1 }] : { id: 1, name: 'n', moves: [1, 2, 3] }))
    const payload = await runPrefetch(event, '/p')
    expect(calls).toHaveLength(3)
    expect(payload!.entries[requestIdentity('GET', '/api/a')]).toEqual({ d: { id: 1, name: 'n' } })
    expect(payload!.entries[requestIdentity('GET', '/api/list')]).toEqual({ d: [{ id: 1, x: 1 }] })
    expect(payload!.entries[requestIdentity('GET', '/api/full')]).toEqual({ d: { id: 1, name: 'n', moves: [1, 2, 3] } })
  })

  it('reports each result through onEntry as soon as its request settles (completion order)', async () => {
    manifest.routes = [route('/s', [{ url: ['/api/slow'] }, { url: ['/api/fast'] }, { url: ['/api/500'] }])]
    const { event } = createEvent({}, async (url) => {
      if (url === '/api/500') throw Object.assign(new Error('x'), { statusCode: 500 })
      await new Promise(resolve => setTimeout(resolve, url === '/api/slow' ? 30 : 1))
      return url
    })
    const seen: unknown[] = []
    const payload = await runPrefetch(event, '/s', { onEntry: (id, entry) => seen.push([id, entry]) })
    expect(seen).toEqual([
      [requestIdentity('GET', '/api/fast'), { d: '/api/fast' }],
      [requestIdentity('GET', '/api/slow'), { d: '/api/slow' }],
    ]) // the 5xx is left to the browser: never reported
    expect(Object.keys(payload!.entries)).toHaveLength(2)
  })

  it('can run a single request by id', async () => {
    const { event, calls } = createEvent()
    await runPrefetch(event, '/dashboard', { only: requestIdentity('GET', '/api/products') })
    expect(calls.map(c => c.url)).toEqual(['/api/products'])
  })

  it('lets the nuxt-pre-fetch:request hook skip requests', async () => {
    runtimeState.hooks.push((context) => {
      if (context.request.url === '/api/users') context.skip = true
    })
    const { event, calls } = createEvent()
    await runPrefetch(event, '/dashboard')
    expect(calls.map(c => c.url)).toEqual(['/api/products'])
  })

  it('respects the concurrency limit', async () => {
    manifest.routes = [route('/many', Array.from({ length: 6 }, (_, n) => ({ url: [`/api/${n}`] })))]
    let inFlight = 0
    let peak = 0
    const { event } = createEvent({}, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return 1
    })
    await runPrefetch(event, '/many')
    expect(peak).toBe(2)
  })

  it('skips requests of Pinia stores the browser reports as active', async () => {
    manifest.routes = [route('/s', [{ url: ['/api/page'] }, { url: ['/api/store'], store: 'users' }, { url: ['/api/other'], store: 'cart' }])]
    const { event, calls } = createEvent()
    await runPrefetch(event, '/s', { skipStores: ['users'] })
    expect(calls.map(c => c.url)).toEqual(['/api/page', '/api/other'])
  })

  it('formats a Server-Timing header value', () => {
    expect(serverTiming(12.345, 2)).toBe('nuxt-pre-fetch;dur=12.3;desc="usePreFetch (2)"')
  })

  it('does nothing when disabled', async () => {
    runtimeState.config.public.nuxtPreFetch.enabled = false
    const { event, calls } = createEvent()
    expect(await runPrefetch(event, '/dashboard')).toBeNull()
    expect(calls).toEqual([])
    runtimeState.config.public.nuxtPreFetch.enabled = true
  })
})
