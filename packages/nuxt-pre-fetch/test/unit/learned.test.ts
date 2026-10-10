import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeState, storageState } from './stubs/imports'
import { manifest } from './stubs/manifest'
import type { DynamicRequestOptions, LearnOptions } from '../../src/runtime/shared/types'
import { learnedRequestId, mergeLearnedPage, readAuthToken, sanitizeLearnedRequest, touchIndex } from '../../src/runtime/server/utils/learned'
import { writeLearnedPage } from '../../src/runtime/server/utils/learned-store'
import { planPrefetch, runPrefetch } from '../../src/runtime/server/utils/runner'
import { requestIdentity } from '../../src/runtime/shared/identity'
import { addLearned, createLearnQueue, endLearned, expectLearned, expectsLearned, learnedIdentity, resetLearned, takeLearned, useLearnedBucket } from '../../src/runtime/utils/learned'

const options: DynamicRequestOptions & LearnOptions = {
  enabled: true,
  allowedHosts: ['odata.example.com'],
  authCookies: ['APP_token'],
  forwardHeaders: ['accept', 'x-tenant'],
  maxRequestsPerPage: 3,
  maxPages: 2,
  maxEntryBytes: 200,
  ttl: 3600,
}

const BROWSER = 'a'.repeat(32)

describe('sanitizeLearnedRequest', () => {
  it('accepts allowed hosts and app-relative URLs', () => {
    expect(sanitizeLearnedRequest({ url: 'https://odata.example.com/DTO_Brand', query: { $top: 5 } }, options))
      .toEqual({ ok: true, host: 'odata.example.com', request: { url: 'https://odata.example.com/DTO_Brand', query: { $top: '5' } } })
    expect(sanitizeLearnedRequest({ url: '/api/items?x=1' }, options)).toMatchObject({ ok: true, request: { url: '/api/items?x=1' } })
  })

  it('rejects other hosts, credentials, protocol-relative URLs and non-objects', () => {
    expect(sanitizeLearnedRequest({ url: 'https://evil.example.org/x' }, options)).toMatchObject({ ok: false })
    expect(sanitizeLearnedRequest({ url: 'https://u:p@odata.example.com/x' }, options)).toMatchObject({ ok: false })
    expect(sanitizeLearnedRequest({ url: '//odata.example.com/x' }, options)).toMatchObject({ ok: false })
    expect(sanitizeLearnedRequest({ url: 'javascript:alert(1)' }, options)).toMatchObject({ ok: false })
    expect(sanitizeLearnedRequest('nope', options)).toMatchObject({ ok: false })
  })

  it('keeps only allowed headers and never a credential header', () => {
    const result = sanitizeLearnedRequest({ url: '/a', headers: { 'Accept': 'application/json', 'Authorization': 'Bearer x', 'Cookie': 'a=b', 'X-Tenant': 't1' } }, options)
    expect(result).toMatchObject({ ok: true, request: { headers: { 'accept': 'application/json', 'x-tenant': 't1' } } })
  })

  it('only allows listed auth cookies', () => {
    expect(sanitizeLearnedRequest({ url: '/a', auth: { cookie: 'APP_token', split: true } }, options)).toMatchObject({ ok: true, request: { auth: { cookie: 'APP_token', split: true } } })
    expect(sanitizeLearnedRequest({ url: '/a', auth: { cookie: 'session' } }, options)).toMatchObject({ ok: false })
  })
})

describe('learned pages', () => {
  const a = { url: '/a' }
  const b = { url: '/b' }
  const c = { url: '/c' }

  it('appends within a visit (deduped) and replaces on a new visit', () => {
    const first = mergeLearnedPage(null, 'v1', [a, b], 10, 1)
    expect(mergeLearnedPage(first, 'v1', [b, c], 10, 2).requests).toEqual([a, b, c])
    expect(mergeLearnedPage(first, 'v2', [c], 10, 2).requests).toEqual([c])
  })

  it('caps requests per page', () => {
    expect(mergeLearnedPage(null, 'v1', [a, b, c], 2, 1).requests).toEqual([a, b])
  })

  it('keeps the newest pages and drops expired ones', () => {
    const index = { '/old': 1, '/x': 900 }
    expect(touchIndex(index, '/y', 1000, 2, 500).sort()).toEqual(['/old'])
    expect(Object.keys(index).sort()).toEqual(['/x', '/y'])
    touchIndex(index, '/z', 1001, 2, 500)
    expect(Object.keys(index).sort()).toEqual(['/y', '/z'])
  })

  it('reads a bearer token from a plain or split cookie', () => {
    expect(readAuthToken({ APP_token: 'abc' }, { cookie: 'APP_token' })).toBe('abc')
    expect(readAuthToken({ APP_token_split_1: 'def', APP_token_split_0: 'abc', APP_token_split_10: 'x' }, { cookie: 'APP_token', split: true })).toBe('abcdefx')
    expect(readAuthToken({}, { cookie: 'APP_token' })).toBeUndefined()
    expect(readAuthToken({ APP_token: 'abc' }, undefined)).toBeUndefined()
  })

  it('identifies a learned request like the browser does', () => {
    const request = { url: 'https://odata.example.com/DTO?$apply=groupby((A))', query: { $top: '5' } }
    expect(learnedRequestId(request)).toBe(learnedIdentity('GET', request.url, { $top: 5 }))
  })
})

describe('runPrefetch with learned requests', () => {
  const calls: Array<{ url: string, init: any }> = []
  function createEvent(cookie = '') {
    const headers: Record<string, string> = cookie ? { cookie } : {}
    return {
      headers,
      node: { req: { headers }, res: { getHeader: () => undefined, setHeader: () => {} } },
      $fetch: async (url: string, init: any) => {
        calls.push({ url, init })
        return { local: url }
      },
    } as any
  }

  beforeEach(() => {
    calls.length = 0
    storageState.data.clear()
    manifest.routes = []
    runtimeState.config.nuxtPreFetch.dynamic = options
    runtimeState.config.nuxtPreFetch.learn = options
    runtimeState.config.public.nuxtPreFetch.learn = true
    vi.stubGlobal('$fetch', async (url: string, init: any) => {
      calls.push({ url, init })
      if (url.includes('/fail')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
      if (url.includes('/big')) return { value: 'x'.repeat(500) }
      return { value: [{ Id: 1 }], url }
    })
  })

  afterEach(() => {
    delete runtimeState.config.nuxtPreFetch.dynamic
    delete runtimeState.config.nuxtPreFetch.learn
    delete runtimeState.config.public.nuxtPreFetch.learn
    vi.unstubAllGlobals()
  })

  it('returns null for a browser that learned nothing on a route without manifest requests', async () => {
    expect(await runPrefetch(createEvent(`npf_id=${BROWSER}`), '/home')).toBeNull()
    expect(await runPrefetch(createEvent(), '/home')).toBeNull()
  })

  it('replays the learned requests with the bearer token of THIS request, success only', async () => {
    const ok = { url: 'https://odata.example.com/DTO_Brand', query: { $top: '5' }, headers: { accept: 'application/json' }, auth: { cookie: 'APP_token' } }
    const local = { url: '/api/local' }
    const failing = { url: 'https://odata.example.com/fail' }
    const big = { url: 'https://odata.example.com/big' }
    await writeLearnedPage(BROWSER, '/home', 'v1', [ok, local, failing], { ...options, maxRequestsPerPage: 10 })
    await writeLearnedPage(BROWSER, '/home', 'v1', [big], { ...options, maxRequestsPerPage: 10 })

    const payload = await runPrefetch(createEvent(`npf_id=${BROWSER}; APP_token=tok123`), '/home')
    const okId = requestIdentity('GET', ok.url, ok.query)
    const localId = requestIdentity('GET', local.url)
    expect(payload?.runtime?.sort()).toEqual([okId, localId].sort())
    expect(payload?.entries[okId]).toEqual({ d: { value: [{ Id: 1 }], url: ok.url } })

    const external = calls.find(call => call.url === ok.url)!
    expect(external.init.headers).toEqual({ accept: 'application/json', authorization: 'Bearer tok123' })
    expect(external.init.query).toEqual({ $top: '5' })
    const internal = calls.find(call => call.url === '/api/local')!
    expect(internal.init.headers['x-nuxt-pre-fetch']).toBe('1')
    // 401 and oversized responses are left to the browser.
    expect(Object.keys(payload!.entries)).toHaveLength(2)
  })

  it('never replays another browser\'s requests, and re-validates against the current options', async () => {
    await writeLearnedPage(BROWSER, '/home', 'v1', [{ url: 'https://odata.example.com/A' }], options)
    expect(await runPrefetch(createEvent(`npf_id=${'b'.repeat(32)}`), '/home')).toBeNull()

    runtimeState.config.nuxtPreFetch.dynamic = { ...options, allowedHosts: [] }
    expect(await runPrefetch(createEvent(`npf_id=${BROWSER}`), '/home')).toBeNull()
  })

  it('plans learned ids before fetching (the stream announces them first)', async () => {
    await writeLearnedPage(BROWSER, '/home?x=1', 'v1', [{ url: '/api/a' }], options)
    const plan = await planPrefetch(createEvent(`npf_id=${BROWSER}`), '/home?x=1')
    expect(plan?.runtime.map(r => r.id)).toEqual([requestIdentity('GET', '/api/a')])
    expect(calls).toEqual([])
  })

  it('is off when learning is disabled', async () => {
    await writeLearnedPage(BROWSER, '/home', 'v1', [{ url: '/api/a' }], options)
    runtimeState.config.public.nuxtPreFetch.learn = false
    expect(await runPrefetch(createEvent(`npf_id=${BROWSER}`), '/home')).toBeNull()
  })
})

describe('client learned bucket', () => {
  const app = () => ({}) as any

  it('serves each learned result once, until navigation or ttl', async () => {
    const bucket = useLearnedBucket(app())
    resetLearned(bucket, '/home', 1000)
    const id = learnedIdentity('GET', 'https://odata.example.com/A', { $top: 5 })
    addLearned(bucket, id, { d: [1, 2] })
    expect(expectsLearned(bucket, id, 1000)).toBe(true)
    expect(await takeLearned(bucket, id, 1000)).toEqual({ data: [1, 2] })
    expect(await takeLearned(bucket, id, 1000)).toBeUndefined()

    addLearned(bucket, id, { d: 1 })
    expect(expectsLearned(bucket, id, 1000 + 61_000)).toBe(false)
    resetLearned(bucket, '/other', 1000)
    expect(expectsLearned(bucket, id, 1000)).toBe(false)
  })

  it('never serves an error entry', async () => {
    const bucket = useLearnedBucket(app())
    resetLearned(bucket, '/home')
    addLearned(bucket, 'x', { e: { s: 401 } })
    expect(expectsLearned(bucket, 'x')).toBe(false)
  })

  it('waits for an announced id that is still streaming', async () => {
    const bucket = useLearnedBucket(app())
    resetLearned(bucket, '/home')
    expectLearned(bucket, ['a', 'b'])
    const a = takeLearned(bucket, 'a')
    const b = takeLearned(bucket, 'b')
    addLearned(bucket, 'a', { d: 'A' })
    endLearned(bucket)
    expect(await a).toEqual({ data: 'A' })
    expect(await b).toBeUndefined()
  })

  it('queues reports per page visit and dedupes them', () => {
    vi.useFakeTimers()
    const sent: Array<{ body: any, beacon: boolean }> = []
    const queue = createLearnQueue((body, beacon) => sent.push({ body: JSON.parse(body), beacon }), 100, 2)
    queue.add('/home', { url: '/a' })
    queue.add('/home', { url: '/a' })
    queue.add('/home', { url: '/b' })
    queue.add('/home', { url: '/c' }) // over maxPerPage
    vi.advanceTimersByTime(100)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body.requests).toEqual([{ url: '/a' }, { url: '/b' }])
    const firstVisit = sent[0]!.body.visit

    queue.add('/other', { url: '/x' })
    queue.flush(true)
    expect(sent[1]).toMatchObject({ beacon: true, body: { path: '/other', requests: [{ url: '/x' }] } })
    expect(sent[1]!.body.visit).not.toBe(firstVisit)
    vi.useRealTimers()
  })
})
