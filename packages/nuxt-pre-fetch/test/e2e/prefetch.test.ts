import { beforeEach, describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import { apiCalls, hits, openPage, playgroundDir, prefetchCalls, resetHits, text, useDist } from './helpers'

useDist()

// Production build (`nuxt build`, node-server preset) of the ssr:false playground.
// `keepPayload` pinned to its default (false) whatever the playground config says.
await setup({ rootDir: playgroundDir, server: true, browser: true, build: true, dev: false, env: { NUXT_PUBLIC_NUXT_PRE_FETCH_KEEP_PAYLOAD: 'false' } })

const PAYLOAD_RE = /<script type="application\/json" id="__NUXT_PRE_FETCH__"[^>]*>(.*?)<\/script>/

async function html(path: string, init?: RequestInit) {
  const response = await fetch(path, init)
  const body = await response.text()
  const match = PAYLOAD_RE.exec(body)
  return { response, body, payload: match ? JSON.parse(match[1]!) : null }
}

beforeEach(resetHits)

describe('initial load (render:html)', () => {
  it('embeds the prefetched results in the SPA shell, fetched on Nitro', async () => {
    const { response, payload, body } = await html('/dashboard')
    expect(body).not.toContain('<div id="users"') // Vue did not render on the server
    expect(payload.path).toBe('/dashboard')
    expect(Object.values(payload.entries)).toEqual(expect.arrayContaining([
      { d: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }] },
      { d: [{ id: 10, name: 'Product A' }] },
    ]))
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await hits()).toMatchObject({ users: { nitro: 1, browser: 0 }, products: { nitro: 1, browser: 0 } })
  })

  it('injects nothing for a page without prefetchable requests', async () => {
    const { payload, response } = await html('/')
    expect(payload).toBeNull()
    expect(response.headers.get('cache-control')).not.toBe('private, no-store')
  })

  it('escapes API data so it cannot leave the JSON element', async () => {
    const { body } = await html('/edge-cases')
    expect(body).not.toContain('<script>window.__pwned')
    expect(body).toContain('\\u003c/script\\u003e')
  })

  it('renders prefetched data with zero browser API requests', async () => {
    const { page, requests } = await openPage('/dashboard')
    expect(await text(page, '#users')).toBe('Ada\nGrace')
    expect(await text(page, '#products')).toBe('Product A')
    expect(await text(page, '#same-users')).toBe('2') // two calls, one key, shared state
    // Default (keepPayload: false): the JSON element is gone once the client has read it.
    expect(await page.locator('#__NUXT_PRE_FETCH__').count()).toBe(0)
    expect(apiCalls(requests)).toEqual([])
    expect(prefetchCalls(requests)).toEqual([])
    expect(await hits()).toMatchObject({ users: { nitro: 1, browser: 0 }, time: { nitro: 1, browser: 0 } })
    await page.close()
  })

  it('a browser reload prefetches again on Nitro', async () => {
    const { page, requests } = await openPage('/dashboard')
    await page.reload({ waitUntil: 'networkidle' })
    expect(await text(page, '#users')).toBe('Ada\nGrace')
    expect(apiCalls(requests)).toEqual([])
    expect((await hits()).users).toEqual({ nitro: 2, browser: 0 })
    await page.close()
  })

  it('refresh() refetches (fetchMode: client → from the browser) and updates reactive data', async () => {
    const { page, requests } = await openPage('/dashboard')
    const before = Number(await text(page, '#time'))
    await page.click('#refresh-time')
    await page.waitForFunction(n => Number(document.querySelector('#time')?.textContent) > n, before)
    await page.click('#refresh-users')
    await page.waitForLoadState('networkidle')
    expect(apiCalls(requests)).toEqual(['/api/time', '/api/users'])
    expect(await text(page, '#users')).toBe('Ada\nGrace')
    await page.close()
  })
})

describe('values and errors', () => {
  it('keeps null, empty, false, 0 and 204 results as real data; a 4xx on the server is retried by the browser', async () => {
    const { page, requests } = await openPage('/edge-cases')
    expect(await text(page, '#null')).toBe('null')
    expect(await text(page, '#no-content')).toBe('undefined')
    expect(await text(page, '#empty')).toBe('[]')
    expect(await text(page, '#false')).toBe('false')
    expect(await text(page, '#zero')).toBe('0')
    expect(await text(page, '#forbidden')).toBe('403')
    expect(await text(page, '#xss')).toBe('</script><script>window.__pwned = true</script>')
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined()
    // The non-analysable call (URL from a variable) falls back to one browser fetch, and the 403 the
    // server got is retried by the browser (serverErrors: 'retry'); nothing else hits the API.
    expect(await text(page, '#dynamic')).toBe('1')
    expect(apiCalls(requests).sort()).toEqual(['/api/forbidden', '/api/products'])
    expect(await hits()).toMatchObject({ forbidden: { nitro: 1, browser: 1 }, null: { nitro: 1, browser: 0 } })
    await page.close()
  })
})

describe('client navigation (prefetch endpoint)', () => {
  it('fetches the destination through Nitro before it renders', async () => {
    const { page, requests } = await openPage('/')
    await page.click('#nav-dashboard')
    await page.waitForSelector('#users li')
    expect(await text(page, '#users')).toBe('Ada\nGrace')
    expect(prefetchCalls(requests)).toEqual(['/__nuxt_pre_fetch?path=%2Fdashboard&stream=1'])
    expect(apiCalls(requests)).toEqual([])
    expect(await hits()).toMatchObject({ users: { nitro: 1, browser: 0 }, products: { nitro: 1, browser: 0 } })
    await page.close()
  })

  it('resolves dynamic route params per destination', async () => {
    const { page, requests } = await openPage('/users/1')
    expect(await text(page, '#user-name')).toBe('Ada')
    await page.click('#nav-user-2')
    await page.waitForFunction(() => document.querySelector('#user-name')?.textContent === 'Grace')
    expect(prefetchCalls(requests)).toEqual(['/__nuxt_pre_fetch?path=%2Fusers%2F2&stream=1'])
    expect(apiCalls(requests)).toEqual([])
    await page.close()
  })

  it('treats a different query as a different request', async () => {
    const { page, requests } = await openPage('/search?status=active')
    expect(await text(page, '#status')).toBe('active')
    await page.click('#nav-search-inactive')
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'inactive')
    expect(apiCalls(requests)).toEqual([])
    expect(prefetchCalls(requests)).toHaveLength(1)
    expect(await hits()).toMatchObject({ 'filtered:active': { nitro: 1, browser: 0 }, 'filtered:inactive': { nitro: 1, browser: 0 } })
    await page.close()
  })

  it('does not call the endpoint for routes without prefetchable requests', async () => {
    const { page, requests } = await openPage('/dashboard')
    await page.click('text=Home')
    await page.waitForSelector('h1:has-text("playground")')
    expect(prefetchCalls(requests)).toEqual([])
    await page.close()
  })
})

describe('authentication', () => {
  it('prefetches with each request\'s own cookies — no cross-user data', async () => {
    const alice = await openPage('/me', { extraHTTPHeaders: { cookie: 'user=alice' } })
    const bob = await openPage('/me', { extraHTTPHeaders: { cookie: 'user=bob' } })
    const anonymous = await openPage('/me')
    expect(await text(alice.page, '#me')).toBe('alice')
    expect(await text(bob.page, '#me')).toBe('bob')
    expect(await text(anonymous.page, '#me-error')).toBe('401')
    // Served from the HTML for alice and bob; the anonymous 401 on the server is retried by the browser.
    expect(apiCalls(alice.requests)).toEqual([])
    expect(apiCalls(bob.requests)).toEqual([])
    expect(apiCalls(anonymous.requests)).toEqual(['/api/me'])
    for (const { page } of [alice, bob, anonymous]) await page.close()
  })
})

describe('endpoint hardening', () => {
  it('only runs manifest requests for app routes', async () => {
    expect((await fetch('/__nuxt_pre_fetch?path=/nope')).status).toBe(404)
    expect((await fetch('/__nuxt_pre_fetch?path=https://evil.example')).status).toBe(400)
    expect((await fetch('/__nuxt_pre_fetch?path=//evil.example/x')).status).toBe(400)
    expect((await fetch('/__nuxt_pre_fetch?path=/dashboard&id=../x')).status).toBe(400)
    expect((await fetch('/__nuxt_pre_fetch?path=/dashboard', { headers: { 'x-nuxt-pre-fetch': '1' } })).status).toBe(400)
    const traversal = await fetch('/__nuxt_pre_fetch?path=/users/..%2Fhits')
    expect(traversal.status === 404 || Object.keys((await traversal.json()).entries).length === 0).toBe(true)
    const ok = await fetch('/__nuxt_pre_fetch?path=/dashboard')
    expect(ok.headers.get('cache-control')).toBe('private, no-store')
    expect((await fetch('/__nuxt_pre_fetch?path=/nope&stream=1')).status).toBe(404) // decided before streaming
  })

  it('streams NDJSON with ?stream=1: a header line, one line per finished request, a done line', async () => {
    const response = await fetch('/__nuxt_pre_fetch?path=/dashboard&stream=1')
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('server-timing')).toContain('nuxt-pre-fetch')
    const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    expect(lines[0]).toEqual({ v: 1, path: '/dashboard' })
    expect(lines.at(-1)).toMatchObject({ done: true })
    const entries = lines.slice(1, -1)
    expect(entries).toHaveLength(3) // users, products, time
    expect(entries.every(line => typeof line.id === 'string' && 'entry' in line)).toBe(true)
    expect(entries.map(line => line.entry.d)).toContainEqual([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }])
  })
})
