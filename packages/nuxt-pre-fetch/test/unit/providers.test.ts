import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeModule, analyzeSFC } from '../../src/build/analyzer'
import { createImportResolver, ManifestBuilder } from '../../src/build/manifest'

describe('analyzeModule', () => {
  it('finds usePreFetch in Pinia setup stores, composables and arrow functions', () => {
    const result = analyzeModule(`
import { defineStore as store } from 'pinia'
import { useHelper } from './helper'
export const useUsersStore = store('users', () => {
  const { data } = usePreFetch('/api/users')
  const route = useRoute()
  const one = usePreFetch(() => \`/api/users/\${route.params.id}\`)
  useHelper()
  function later() { return usePreFetch('/api/later') }
  return { data, one, later }
})
export function useProducts() {
  return usePreFetch('/api/products')
}
const local = () => usePreFetch('/api/local')
export { local as useLocal }
export const useOptions = store('options', { state: () => ({}), actions: { load() { return usePreFetch('/api/x') } } })
`, 'stores/users.ts')
    expect(result.exports).toEqual({ useUsersStore: 'useUsersStore', useProducts: 'useProducts', useLocal: 'local', useOptions: 'useOptions' })
    const store = result.providers.useUsersStore!
    expect(store.storeId).toBe('users')
    expect(store.requests.map(r => r.url)).toEqual([['/api/users'], ['/api/users/', { p: 'id' }]])
    // Every top-level use*() call is recorded; the builder only follows those resolving to app sources.
    expect(store.calls.map(c => c.name)).toEqual(['useRoute', 'useHelper'])
    expect(store.warnings[0]!.message).toContain('inside a function')
    expect(result.providers.useProducts!.requests.map(r => r.url)).toEqual([['/api/products']])
    expect(result.providers.local!.requests.map(r => r.url)).toEqual([['/api/local']])
    // Option stores have no setup scope: actions run later, nothing to prefetch.
    expect(result.providers.useOptions).toBeUndefined()
    expect(result.imports.useHelper).toEqual({ source: './helper', imported: 'useHelper' })
  })

  it('accepts useRouter().currentRoute.value as the route (the reliable one inside stores)', () => {
    const result = analyzeModule(`
export const useTeamStore = defineStore('team', () => {
  const route = useRouter().currentRoute.value
  const router = useRouter()
  const team = String(route.query.ids ?? '').split(',').map(id => usePreFetch(\`/api/p/\${id}\`))
  const one = usePreFetch(() => \`/api/u/\${router.currentRoute.value.params.id}\`)
  return { team, one }
})`, 'stores/team.ts')
    const store = result.providers.useTeamStore!
    expect(store.warnings).toEqual([])
    expect(store.requests.map(r => [r.url, r.each])).toEqual([
      [['/api/p/', { item: true }], { q: 'ids', sep: ',' }],
      [['/api/u/', { p: 'id' }], undefined],
    ])
  })

  it('records top-level use*() calls and imports of a page', () => {
    const page = analyzeSFC(`<script setup lang="ts">
import { useCart as useBasket } from '~/stores/cart'
const users = useUsersStore()
const { items } = storeToRefs(useBasket())
onMounted(() => useNotCalledAtSetup())
</script>`, 'pages/x.vue')
    expect(page.calls.map(c => c.name)).toEqual(['useUsersStore', 'useBasket'])
    expect(page.imports.useBasket).toEqual({ source: '~/stores/cart', imported: 'useCart' })
  })
})

describe('ManifestBuilder: following pages into stores and composables', () => {
  let root: string
  const file = (path: string, content: string) => {
    const full = join(root, path)
    mkdirSync(resolve(full, '..'), { recursive: true })
    writeFileSync(full, content)
    return full
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'nuxt-pre-fetch-'))
    file('app/stores/users.ts', `
export const useUsersStore = defineStore('users', () => {
  const { data } = usePreFetch('/api/users')
  const extra = useFormatting()
  return { data, extra }
})`)
    file('app/composables/useFormatting.ts', `
export function useFormatting() {
  return usePreFetch('/api/formats')
}`)
    file('app/composables/useProduct.ts', `
import { useUsersStore } from '~/stores/users'
export default function useProduct() {
  const route = useRoute()
  useUsersStore()
  return usePreFetch(() => \`/api/products/\${route.params.id}\`)
}`)
    file('app/composables/loop.ts', `
export function useA() { useB(); return usePreFetch('/api/a') }
export function useB() { useA(); return usePreFetch('/api/b') }`)
    file('app/pages/users.vue', `<script setup lang="ts">\nconst store = useUsersStore()\n</script>`)
    file('app/pages/products/[id].vue', `<script setup lang="ts">\nimport useProduct from '../../composables/useProduct'\nconst product = useProduct()\n</script>`)
    file('app/pages/loop.vue', `<script setup lang="ts">\nimport { useA } from '~/composables/loop'\nuseA()\n</script>`)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const build = () => {
    const builder = new ManifestBuilder(root, createImportResolver({ '~': join(root, 'app') }))
    builder.setAutoImports([
      { name: 'useUsersStore', from: join(root, 'app/stores/users') },
      { name: 'useFormatting', from: join(root, 'app/composables/useFormatting') },
    ])
    builder.setPages([
      { path: '/users', file: join(root, 'app/pages/users.vue') },
      { path: '/products/:id()', file: join(root, 'app/pages/products/[id].vue') },
      { path: '/loop', file: join(root, 'app/pages/loop.vue') },
    ])
    return { builder, ...builder.build() }
  }

  it('prefetches a store used by a page (auto-imported), including composables the store calls', () => {
    const { manifest } = build()
    const users = manifest.routes.find(r => r.pattern === '/users')!
    expect(users.requests.map(r => [r.url, r.store])).toEqual([
      [['/api/users'], 'users'],
      [['/api/formats'], 'users'], // a composable used by the store belongs to the store
    ])
  })

  it('follows an explicitly imported default-export composable and the store it uses', () => {
    const { manifest } = build()
    const product = manifest.routes.find(r => r.pattern === '/products/:id()')!
    expect(product.requests.map(r => [r.url, r.store ?? null])).toEqual([
      [['/api/products/', { p: 'id' }], null],
      [['/api/users'], 'users'],
      [['/api/formats'], 'users'],
    ])
  })

  it('survives cycles between composables', () => {
    const { manifest } = build()
    expect(manifest.routes.find(r => r.pattern === '/loop')!.requests.map(r => r.url)).toEqual([['/api/a'], ['/api/b']])
  })

  it('watches the stores and composables it read', () => {
    const { builder } = build()
    expect([...builder.watchedFiles].map(f => f.replace(root, '').replace(/\\/g, '/')).sort()).toEqual([
      '/app/composables/loop.ts',
      '/app/composables/useFormatting.ts',
      '/app/composables/useProduct.ts',
      '/app/pages/loop.vue',
      '/app/pages/products/[id].vue',
      '/app/pages/users.vue',
      '/app/stores/users.ts',
    ])
  })
})
