import { describe, expect, it } from 'vitest'
import { analyzeSFC } from '../../src/build/analyzer'

const page = (script: string, lang = 'ts') => `<script setup lang="${lang}">\n${script}\n</script>\n<template><div /></template>\n`

describe('analyzeSFC', () => {
  it('finds literal GET requests at the top level of <script setup>', () => {
    const result = analyzeSFC(page(`
interface User { id: number }
const { data: users } = await usePreFetch<User[]>('/api/users', { key: 'users', default: () => [] })
const { data: products } = await usePreFetch('/api/products')
`), 'pages/dashboard.vue')
    expect(result.warnings).toEqual([])
    expect(result.requests).toEqual([
      { url: ['/api/users'], source: 'pages/dashboard.vue:4' },
      { url: ['/api/products'], source: 'pages/dashboard.vue:5' },
    ])
  })

  it('turns route params in template literals and getters into URL parts', () => {
    const result = analyzeSFC(page(`
const route = useRoute()
await usePreFetch(\`/api/users/\${route.params.id}\`)
await usePreFetch(() => \`/api/posts/\${useRoute().params.slug as string}/comments\`)
`), 'pages/users/[id].vue')
    expect(result.warnings).toEqual([])
    expect(result.requests.map(r => r.url)).toEqual([
      ['/api/users/', { p: 'id' }],
      ['/api/posts/', { p: 'slug' }, '/comments'],
    ])
  })

  it('turns route.query in URL templates into query parts', () => {
    const result = analyzeSFC(page(`
const route = useRoute()
await usePreFetch(() => \`https://pokeapi.co/api/v2/pokemon/\${route.query.id}\`, { lazy: true })
`), 'p.vue')
    expect(result.warnings).toEqual([])
    expect(result.requests[0]!.url).toEqual(['https://pokeapi.co/api/v2/pokemon/', { q: 'id' }])
  })

  it('records literal and route-derived query values, headers and baseURL', () => {
    const result = analyzeSFC(page(`
const route = useRoute()
await usePreFetch('/users', {
  baseURL: '/api/',
  method: 'get',
  query: { status: 'active', page: route.query.page, ids: [1, 2], limit: -1 },
  params: { id: route.params.id },
  headers: { 'X-Tenant': 'acme' },
  transform: (users: unknown[]) => users.length,
  lazy: true,
})
`), 'pages/x.vue')
    expect(result.warnings).toEqual([])
    expect(result.requests[0]).toEqual({
      url: ['/api/users'],
      query: { status: { v: 'active' }, page: { rq: 'page' }, ids: { v: [1, 2] }, limit: { v: -1 }, id: { rp: 'id' } },
      headers: { 'x-tenant': 'acme' },
      source: 'pages/x.vue:4',
    })
  })

  it('accepts reactive query values via computed() and a reactive whole query', () => {
    const result = analyzeSFC(page(`
const route = useRoute()
await usePreFetch('/api/a', { query: { s: computed(() => route.query.s) } })
await usePreFetch('/api/b', { query: computed(() => ({ s: route.query.s, n: 1 })) })
await usePreFetch('/api/c', { query: () => ({ id: route.params.id }) })
`), 'p.vue')
    expect(result.warnings).toEqual([])
    expect(result.requests.map(r => r.query)).toEqual([
      { s: { rq: 's' } },
      { s: { rq: 's' }, n: { v: 1 } },
      { id: { rp: 'id' } },
    ])
  })

  it('records a literal pick for server-side trimming, but not alongside transform', () => {
    const result = analyzeSFC(page(`
await usePreFetch('https://pokeapi.co/api/v2/pokemon/1', { pick: ['id', 'name'] })
await usePreFetch('/api/b', { pick: ['id'], transform: (x: any) => x })
const keys = ['id']
await usePreFetch('/api/c', { pick: keys })
`), 'p.vue')
    expect(result.warnings).toEqual([])
    expect(result.requests.map(r => r.pick)).toEqual([['id', 'name'], undefined, undefined])
  })

  it('skips server: false silently', () => {
    const result = analyzeSFC(page(`await usePreFetch('/api/a', { server: false })`), 'p.vue')
    expect(result).toMatchObject({ requests: [], warnings: [] })
  })

  it.each([
    ['dynamic URL', `const url = '/api/a'\nawait usePreFetch(url)`, 'URL must be'],
    ['non-GET', `await usePreFetch('/api/a', { method: 'POST' })`, 'only GET'],
    ['body', `await usePreFetch('/api/a', { body: { a: 1 } })`, 'body'],
    ['spread options', `const o = {}\nawait usePreFetch('/api/a', { ...o })`, 'spreads'],
    ['non-literal query', `const s = 'x'\nawait usePreFetch('/api/a', { query: { s } })`, 'must be a literal'],
    ['template over a non-param', `const id = 1\nawait usePreFetch(\`/api/a/\${id}\`)`, 'route.params'],
    ['relative URL', `await usePreFetch('api/a')`, 'absolute'],
    ['dynamic origin', `const route = useRoute()\nawait usePreFetch(\`https://\${route.params.host}/x\`)`, 'origin'],
    ['custom $fetch', `await usePreFetch('/api/a', { $fetch: myFetch })`, '$fetch'],
  ])('warns and skips: %s', (_name, script, message) => {
    const result = analyzeSFC(page(script), 'p.vue')
    expect(result.requests).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]!.message).toContain(message)
  })

  it('does not prefetch calls inside functions, branches or loops', () => {
    const result = analyzeSFC(page(`
function load() { return usePreFetch('/api/a') }
if (flag) await usePreFetch('/api/b')
const ok = await usePreFetch('/api/c')
`), 'p.vue')
    expect(result.requests.map(r => r.url)).toEqual([['/api/c']])
    expect(result.warnings.map(w => w.line)).toEqual([3, 4])
  })

  it('ignores a locally shadowed usePreFetch', () => {
    const result = analyzeSFC(page(`import { usePreFetch } from './mine'\nawait usePreFetch('/api/a')`), 'p.vue')
    expect(result).toMatchObject({ requests: [], warnings: [] })
  })

  it('supports a useRoute alias and plain JS', () => {
    const result = analyzeSFC(page(`import { useRoute as r } from '#imports'\nconst rt = r()\nawait usePreFetch(\`/api/\${rt.params.id}\`)`, 'js'), 'p.vue')
    expect(result.requests.map(x => x.url)).toEqual([['/api/', { p: 'id' }]])
  })

  it('reports usage in a non-setup <script>', () => {
    const result = analyzeSFC(`<script>export default { setup() { return usePreFetch('/api/a') } }</script>`, 'p.vue')
    expect(result.warnings[0]!.message).toContain('non-setup')
  })

  it('reports parse errors instead of throwing', () => {
    const result = analyzeSFC(page(`await usePreFetch('/api/a'`), 'p.vue')
    expect(result.requests).toEqual([])
    expect(result.warnings[0]!.message).toContain('could not parse')
  })
})
