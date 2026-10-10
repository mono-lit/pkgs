import { describe, expect, it } from 'vitest'
import { createPage, fetch, setup, url } from '@nuxt/test-utils/e2e'
import { apiCalls, hits, playgroundDir, prefetchCalls, resetHits, text, useDist } from './helpers'

useDist()

await setup({ rootDir: playgroundDir, server: true, browser: true, build: true, dev: false })

/** Opens a page in a fresh browser context; records the browser's own API/endpoint calls. */
async function open(path: string, cookies: Record<string, string> = {}) {
  const page = await createPage()
  const base = new URL(url('/'))
  await page.context().addCookies(Object.entries(cookies).map(([name, value]) => ({ name, value, domain: base.hostname, path: '/' })))
  const requests: string[] = []
  page.on('request', (request) => {
    const { pathname, search } = new URL(request.url())
    if (pathname.startsWith('/api/') || pathname.startsWith('/__nuxt_pre_fetch')) requests.push(`${pathname}${search}`)
  })
  await page.goto(url(path), { waitUntil: 'networkidle' })
  await page.waitForSelector('#declared-source')
  return { page, requests }
}

describe('definePrefetch (app/prefetch/declared.ts)', () => {
  it('the FIRST visit already gets the runtime-built request from the HTML — no learning', async () => {
    await resetHits()
    const { page, requests } = await open('/declared', { demo_token: 't1', demo_q: 'zz' })
    expect(await text(page, '#declared-source')).toBe('prefetched')
    expect(await text(page, '#declared-q')).toBe('zz')
    expect(await text(page, '#declared-auth')).toBe('Bearer t1')
    expect(apiCalls(requests)).toEqual([])
    expect(prefetchCalls(requests)).toEqual([]) // no learn POST either
    expect((await hits())['learned-items']).toEqual({ nitro: 1, browser: 0 })
    await page.close()
  })

  it('the HTML carries the declared result', async () => {
    const html = await (await fetch('/declared', { headers: { cookie: 'demo_q=hello' } })).text()
    const payload = JSON.parse(/id="__NUXT_PRE_FETCH__"[^>]*>(.*?)<\/script>/.exec(html)![1]!)
    expect(payload.runtime).toHaveLength(1)
    expect(Object.values(payload.entries)).toEqual([{ d: expect.objectContaining({ q: 'hello', auth: null }) }])
  })

  it('client navigation streams the declared page from the endpoint', async () => {
    const { page, requests } = await open('/declared', { demo_q: 'nav' })
    await page.goto(url('/'), { waitUntil: 'networkidle' })
    requests.length = 0
    await page.click('#nav-declared')
    await page.waitForFunction(() => document.querySelector('#declared-q')?.textContent === 'nav')
    expect(await text(page, '#declared-source')).toBe('prefetched')
    expect(prefetchCalls(requests).map(decodeURIComponent)).toEqual(['/__nuxt_pre_fetch?path=/declared&stream=1'])
    expect(apiCalls(requests)).toEqual([])
    await page.close()
  })
})

describe('a prefetch that fails on the server', () => {
  it('is reported to the browser (payload.failed) and retried there — the page still gets its data', async () => {
    await resetHits()
    const html = await (await fetch('/declared', { headers: { cookie: 'demo_q=server-down' } })).text()
    const payload = JSON.parse(/id="__NUXT_PRE_FETCH__"[^>]*>(.*?)<\/script>/.exec(html)![1]!)
    expect(Object.values(payload.failed)).toEqual([{ s: 503, r: 'http' }])
    expect(payload.entries).toEqual({})

    const { page, requests } = await open('/declared', { demo_q: 'server-down' })
    expect(await text(page, '#declared-source')).toBe('network')
    expect(await text(page, '#declared-q')).toBe('server-down')
    expect(apiCalls(requests)).toEqual(['/api/learned-items?q=server-down'])
    expect((await hits())['learned-items']).toEqual({ nitro: 2, browser: 1 })
    await page.close()
  })
})
