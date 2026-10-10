import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { joinBaseURL, normalizeQuery, requestIdentity } from '../../src/runtime/shared/identity'
import { asyncDataKeyFor, prefetchIdentity } from '../../src/runtime/utils/request'
import { parseRequestQuery, resolveRequest } from '../../src/runtime/server/utils/resolve'
import { serializeForHTML } from '../../src/runtime/server/utils/serialize'

const external = { allowedHosts: [], forwardHeaders: {} }

describe('request identity', () => {
  it('ignores query key order and merges URL-embedded queries', () => {
    expect(requestIdentity('GET', '/api/a?b=2', { a: '1' })).toBe(requestIdentity('get', '/api/a', { b: '2', a: '1' }))
  })

  it('distinguishes query values, methods and paths', () => {
    const active = requestIdentity('GET', '/api/users', { status: 'active' })
    expect(active).not.toBe(requestIdentity('GET', '/api/users', { status: 'inactive' }))
    expect(active).not.toBe(requestIdentity('GET', '/api/users'))
    expect(active).not.toBe(requestIdentity('GET', '/api/users2', { status: 'active' }))
  })

  it('normalises query values like they go over the wire', () => {
    expect(normalizeQuery({ a: 1, b: true, c: undefined, d: null, e: [1, undefined, 'x'] }, { f: ref('r'), g: () => 'getter' }))
      .toEqual({ a: '1', b: 'true', d: '', e: ['1', 'x'], f: 'r', g: 'getter' })
  })

  it('joins baseURL like the analyzer', () => {
    expect(joinBaseURL('/api/', '/users')).toBe('/api/users')
    expect(joinBaseURL('/api', 'https://x.dev/a')).toBe('https://x.dev/a')
  })

  it('client and server compute the same id for the same request', () => {
    // Browser: usePreFetch(`/api/users/${route.params.id}`, { query: { tab: route.query.tab, n: 5 } })
    const clientId = prefetchIdentity('/api/users/a b', { query: { tab: 'x y', n: 5, missing: undefined } })
    // Server: the same call from the manifest, resolved against /users/a%20b?tab=x%20y
    const server = resolveRequest(
      { url: ['/api/users/', { p: 'id' }], query: { tab: { rq: 'tab' }, n: { v: 5 }, missing: { rq: 'missing' } }, source: 's' },
      { id: 'a b' },
      parseRequestQuery('tab=x%20y'),
      external,
    )
    expect(server.ok && server.request.id).toBe(clientId)
    expect(server.ok && server.request.url).toBe('/api/users/a%20b')
  })

  it('treats a flag query (?flag) like vue-router null', () => {
    const client = prefetchIdentity('/api/a', { query: { flag: null } })
    const server = resolveRequest({ url: ['/api/a'], query: { flag: { rq: 'flag' } }, source: 's' }, {}, parseRequestQuery('flag'), external)
    expect(server.ok && server.request.id).toBe(client)
  })

  it('never prefetches non-GET or body requests', () => {
    expect(prefetchIdentity('/api/a', { method: 'POST' })).toBeNull()
    expect(prefetchIdentity('/api/a', { body: {} })).toBeNull()
    expect(asyncDataKeyFor('/api/a', { method: 'POST', body: { x: 1 } })).not.toBe(asyncDataKeyFor('/api/a', { method: 'POST', body: { x: 2 } }))
  })
})

describe('resolveRequest', () => {
  it('rejects params that would change the path or query', () => {
    for (const id of ['..', '.', 'a/b', 'a?b', 'a#b', 'a\\b']) {
      const result = resolveRequest({ url: ['/api/users/', { p: 'id' }], source: 's' }, { id }, {}, external)
      expect(result.ok, id).toBe(false)
    }
  })

  it('fills query parts from the request query and skips the request when it is missing', () => {
    const request = { url: ['/api/pokemon/', { q: 'id' }], source: 's' }
    const ok = resolveRequest(request, {}, parseRequestQuery('id=25&test=1'), external)
    expect(ok.ok && ok.request).toMatchObject({ url: '/api/pokemon/25', id: requestIdentity('GET', '/api/pokemon/25') })
    expect(resolveRequest(request, {}, {}, external).ok).toBe(false)
    expect(resolveRequest(request, {}, parseRequestQuery('id=..%2Fx'), external).ok).toBe(false)
  })

  it('only allows listed external hosts', () => {
    const request = { url: ['https://api.example.com/v1/items'], source: 's' }
    expect(resolveRequest(request, {}, {}, external).ok).toBe(false)
    const allowed = resolveRequest(request, {}, {}, { allowedHosts: ['API.example.com'], forwardHeaders: {} })
    expect(allowed.ok && allowed.request).toMatchObject({ external: true, host: 'api.example.com' })
  })

  it('joins catch-all params like a template literal', () => {
    const result = resolveRequest({ url: ['/api/docs/', { p: 'slug' }], source: 's' }, { slug: ['a', 'b'] }, {}, external)
    expect(result.ok && result.request.id).toBe(requestIdentity('GET', '/api/docs/a,b'))
  })
})

describe('serializeForHTML', () => {
  it('cannot break out of the script element and round-trips', () => {
    const value = { html: '</script><!-- <script>&', ls: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}` }
    const serialized = serializeForHTML(value)
    expect(serialized).not.toMatch(/[<>&\u2028\u2029]/)
    expect(JSON.parse(serialized)).toEqual(value)
  })
})
