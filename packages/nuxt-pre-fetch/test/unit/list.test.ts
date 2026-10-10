import { beforeEach, describe, expect, it } from 'vitest'
import { analyzeSFC } from '../../src/build/analyzer'
import { compileRoutePath } from '../../src/build/routes'
import { listItems, parseRequestQuery, resolveRequest } from '../../src/runtime/server/utils/resolve'
import { runPrefetch } from '../../src/runtime/server/utils/runner'
import { requestIdentity } from '../../src/runtime/shared/identity'
import { prefetchIdentity } from '../../src/runtime/utils/request'
import { runtimeState } from './stubs/imports'
import { manifest } from './stubs/manifest'

const page = (script: string) => `<script setup lang="ts">\n${script}\n</script>\n`
const external = { allowedHosts: ['pokeapi.co'], forwardHeaders: {} }

describe('list query: analyzer', () => {
  it('understands String(route.query.ids ?? \'\').split(sep).map(id => usePreFetch(...))', () => {
    const result = analyzeSFC(page(`
const route = useRoute()
const team = String(route.query.ids ?? '').split(',').map(id => ({
  pokemon: usePreFetch(() => \`https://pokeapi.co/api/v2/pokemon/\${id}\`, { key: \`p:\${id}\`, lazy: true, pick: ['id', 'name'] }),
  species: usePreFetch(\`https://pokeapi.co/api/v2/pokemon-species/\${id}\`),
  fixed: usePreFetch('/api/static'),
}))
`), 'p.vue')
    expect(result.warnings).toEqual([])
    expect(result.requests.map(r => ({ url: r.url, each: r.each }))).toEqual([
      { url: ['https://pokeapi.co/api/v2/pokemon/', { item: true }], each: { q: 'ids', sep: ',' } },
      { url: ['https://pokeapi.co/api/v2/pokemon-species/', { item: true }], each: { q: 'ids', sep: ',' } },
      { url: ['/api/static'], each: undefined },
    ])
  })

  it('accepts the plain and `as string` / `|| \'\'` forms and a block body', () => {
    const result = analyzeSFC(page(`
const route = useRoute()
const a = (route.query.ids as string).split('|').map((id) => { return usePreFetch(\`/api/a/\${id}\`) })
const b = (useRoute().query.tags || '').split(',').map(function (tag) { return usePreFetch(\`/api/t/\${tag}\`) })
`), 'p.vue')
    expect(result.warnings).toEqual([])
    expect(result.requests.map(r => r.each)).toEqual([{ q: 'ids', sep: '|' }, { q: 'tags', sep: ',' }])
  })

  it('does not treat other maps as list queries', () => {
    const result = analyzeSFC(page(`
const ids = ['1', '2']
const a = ids.map(id => usePreFetch(\`/api/a/\${id}\`))
`), 'p.vue')
    expect(result.requests).toEqual([])
    expect(result.warnings[0]!.message).toContain('inside a function')
  })

  it('records a literal .slice(0, n) cap between split and map', () => {
    const result = analyzeSFC(page(`
const route = useRoute()
const a = String(route.query.ids ?? '').split(',').slice(0, 250).map(id => usePreFetch(\`/api/a/\${id}\`))
const b = String(route.query.ids ?? '').split(',').slice(1, 3).map(id => usePreFetch(\`/api/b/\${id}\`))
`), 'p.vue')
    expect(result.requests.map(r => r.each)).toEqual([{ q: 'ids', sep: ',', max: 250 }])
    // Any other slice is not a supported list shape: its calls are inside a callback.
    expect(result.warnings[0]!.message).toContain('inside a function')
  })
})

describe('list query: server', () => {
  it('splits, de-duplicates, drops empty items and caps (0 = unlimited)', () => {
    const each = { q: 'ids', sep: ',' }
    expect(listItems(each, parseRequestQuery('ids=25,6,,25,150'), 20)).toEqual(['25', '6', '150'])
    expect(listItems(each, parseRequestQuery('ids=1,2,3,4'), 2)).toEqual(['1', '2'])
    expect(listItems(each, parseRequestQuery('ids=1,2,3,4'), 0)).toEqual(['1', '2', '3', '4'])
    expect(listItems(each, {}, 20)).toBeNull()
  })

  it('applies the page\'s own .slice(0, n) to the raw split, like the browser, even with no maxListItems', () => {
    const each = { q: 'ids', sep: ',', max: 3 }
    const many = Array.from({ length: 600 }, (_, i) => i + 1).join(',')
    expect(listItems(each, parseRequestQuery(`ids=${many}`), 0)).toEqual(['1', '2', '3'])
    // The raw slice counts empty/duplicate entries, exactly as `split(',').slice(0, 3)` does in the page.
    expect(listItems(each, parseRequestQuery('ids=1,1,,2,3'), 0)).toEqual(['1'])
    expect(listItems({ ...each, max: 250 }, parseRequestQuery(`ids=${many}`), 0)).toHaveLength(250)
  })

  it('fills the item into the URL with the same identity the browser computes', () => {
    const request = { url: ['https://pokeapi.co/api/v2/pokemon/', { item: true as const }], each: { q: 'ids', sep: ',' }, source: 's' }
    const resolved = resolveRequest(request, {}, {}, external, '25')
    expect(resolved.ok && resolved.request.id).toBe(prefetchIdentity('https://pokeapi.co/api/v2/pokemon/25'))
    expect(resolveRequest(request, {}, {}, external, '../x').ok).toBe(false)
  })

  describe('runPrefetch', () => {
    beforeEach(() => {
      const compiled = compileRoutePath('/team')!
      manifest.routes = [{
        pattern: '/team',
        re: compiled.re,
        params: compiled.params,
        requests: [{ url: ['/api/p/', { item: true }], each: { q: 'ids', sep: ',' }, source: 'team' }],
      }]
      runtimeState.hooks = []
    })

    const run = async (path: string) => {
      const calls: string[] = []
      const event = { headers: {}, node: { req: { headers: {} } }, $fetch: async (url: string) => { calls.push(url); return { url } } } as any
      const payload = await runPrefetch(event, path)
      return { calls, payload }
    }

    it('expands one request per list item, capped by maxListItems', async () => {
      runtimeState.config.nuxtPreFetch.maxListItems = 3
      const { calls, payload } = await run('/team?ids=1,2,2,3,4,5')
      expect(calls).toEqual(['/api/p/1', '/api/p/2', '/api/p/3'])
      expect(Object.keys(payload!.entries)).toEqual(['1', '2', '3'].map(id => requestIdentity('GET', `/api/p/${id}`)))
    })

    it('expands every item when maxListItems is 0', async () => {
      runtimeState.config.nuxtPreFetch.maxListItems = 0
      const { calls } = await run(`/team?ids=${Array.from({ length: 50 }, (_, i) => i + 1).join(',')}`)
      expect(calls).toHaveLength(50)
      runtimeState.config.nuxtPreFetch.maxListItems = 3
    })

    it('runs nothing without the list query', async () => {
      const { calls, payload } = await run('/team')
      expect(calls).toEqual([])
      expect(payload!.entries).toEqual({})
    })
  })
})
