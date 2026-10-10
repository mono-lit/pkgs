import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeState } from './stubs/imports'
import { manifest } from './stubs/manifest'
import { definitions } from './stubs/definitions'
import { definitionsCode, scanDefinitions } from '../../src/build/definitions'
import { collectPrefetch, definePrefetch, PREFETCH_DESCRIPTOR, type PrefetchDescriptor } from '../../src/runtime/server/utils/define'
import { planPrefetch, runPrefetch } from '../../src/runtime/server/utils/runner'
import { requestIdentity } from '../../src/runtime/shared/identity'
import { compileRoutePath } from '../../src/build/routes'

const dynamic = { allowedHosts: ['odata.example.com'], authCookies: ['APP_token'], forwardHeaders: ['accept'], maxRequestsPerPage: 10, maxEntryBytes: 200 }

function register(pattern: string, handler: Parameters<typeof definePrefetch>[1]) {
  const compiled = compileRoutePath(pattern.replace(/:(\w+)(?!\(|\w)/g, ':$1()'))!
  definitions.push({ pattern, re: compiled.re, params: compiled.params, definition: definePrefetch(pattern, handler) })
}

/** A descriptor like a data library would create. */
function describeCall(url: string, query: Record<string, string>): PrefetchDescriptor {
  return {
    [PREFETCH_DESCRIPTOR]: true,
    collect: (_ctx, emit) => emit({ url, query, auth: { cookie: 'APP_token' } }),
  }
}

describe('scanDefinitions', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'npf-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the route pattern of every definePrefetch file (nested too)', () => {
    writeFileSync(join(dir, 'home.ts'), `export default definePrefetch('/home', () => [])`)
    mkdirSync(join(dir, 'users'))
    writeFileSync(join(dir, 'users', 'detail.ts'), `export default definePrefetch("/users/:id", () => [])`)
    writeFileSync(join(dir, 'helper.ts'), `export const x = 1`)
    writeFileSync(join(dir, 'bad.ts'), 'const p = "/x"; export default definePrefetch(p, () => [])')
    const { definitions: found, warnings } = scanDefinitions(dir)
    expect(found.map(d => d.pattern)).toEqual(['/home', '/users/:id'])
    expect(found[1]!.params).toEqual([{ name: 'id', repeat: false }])
    expect(new RegExp(found[1]!.re, 'i').test('/users/7')).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(definitionsCode(found)).toContain('definition: d1')
  })

  it('a missing directory is no definitions', () => {
    expect(scanDefinitions(join(dir, 'nope'))).toEqual({ definitions: [], warnings: [] })
  })
})

describe('collectPrefetch', () => {
  it('collects plain requests and descriptors; a failing descriptor only drops itself', async () => {
    const errors: unknown[] = []
    const failing: PrefetchDescriptor = { [PREFETCH_DESCRIPTOR]: true, collect: () => { throw new Error('boom') } }
    const requests = await collectPrefetch(() => [
      { url: '/api/a' },
      describeCall('https://odata.example.com/B', { $top: '5' }),
      failing,
      null,
      false,
    ], {} as any, e => errors.push(e))
    expect(requests).toEqual([{ url: '/api/a' }, { url: 'https://odata.example.com/B', query: { $top: '5' }, auth: { cookie: 'APP_token' } }])
    expect(errors).toHaveLength(1)
  })
})

describe('runPrefetch with definePrefetch', () => {
  const calls: Array<{ url: string, init: any }> = []
  const event = (cookie = '') => {
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
    manifest.routes = []
    definitions.length = 0
    runtimeState.config.nuxtPreFetch.dynamic = dynamic
    vi.stubGlobal('$fetch', async (url: string, init: any) => {
      calls.push({ url, init })
      return { value: [{ Id: 1 }] }
    })
  })

  afterEach(() => {
    definitions.length = 0
    delete runtimeState.config.nuxtPreFetch.dynamic
    vi.unstubAllGlobals()
  })

  it('runs the matching definition on the FIRST request: fetched with the cookie bearer, served as runtime entries', async () => {
    register('/home', ctx => [
      { url: '/api/me' },
      describeCall('https://odata.example.com/DTO_Brand', { $top: ctx.cookie('size') ?? '5' }),
    ])
    register('/other', () => [{ url: '/api/never' }])
    const payload = await runPrefetch(event('APP_token=tok; size=7'), '/home')
    const brandId = requestIdentity('GET', 'https://odata.example.com/DTO_Brand', { $top: '7' })
    expect(payload?.runtime?.sort()).toEqual([brandId, requestIdentity('GET', '/api/me')].sort())
    expect(payload?.entries[brandId]).toEqual({ d: { value: [{ Id: 1 }] } })
    expect(calls.find(c => c.url.includes('DTO_Brand'))!.init.headers).toEqual({ authorization: 'Bearer tok' })
    expect(calls.map(c => c.url)).not.toContain('/api/never')
  })

  it('passes route params and query; validates requests against `dynamic`', async () => {
    register('/users/:id', ctx => [
      { url: `/api/users/${ctx.route.params.id}`, query: { tab: String(ctx.route.query.tab) } },
      { url: 'https://evil.example.org/x' },
    ])
    const plan = await planPrefetch(event(), '/users/42?tab=posts')
    expect(plan?.runtime.map(r => r.request)).toEqual([{ url: '/api/users/42', query: { tab: 'posts' } }])
  })

  it('a throwing or slow handler costs only its requests', async () => {
    register('/home', () => { throw new Error('nope') })
    register('/home', () => new Promise(() => {})) // never settles: cut by the timeout
    runtimeState.config.nuxtPreFetch.timeout = 50
    const plan = await planPrefetch(event(), '/home')
    runtimeState.config.nuxtPreFetch.timeout = 1000
    expect(plan?.runtime).toEqual([])
  })
})
