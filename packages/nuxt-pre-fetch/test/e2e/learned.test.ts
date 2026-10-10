import { describe, expect, it } from 'vitest'
import { createPage, setup, url } from '@nuxt/test-utils/e2e'
import type { Page } from 'playwright-core'
import { apiCalls, hits, playgroundDir, prefetchCalls, resetHits, text, useDist } from './helpers'

useDist()

await setup({ rootDir: playgroundDir, server: true, browser: true, build: true, dev: false })

/** Opens `/learned…` in a fresh browser context; records the browser's own API/endpoint calls. */
async function open(path: string, cookies: Record<string, string> = {}) {
  const page = await createPage()
  const base = new URL(url('/'))
  await page.context().addCookies(Object.entries(cookies).map(([name, value]) => ({ name, value, domain: base.hostname, path: '/' })))
  const requests: string[] = []
  page.on('request', (request) => {
    const { pathname, search } = new URL(request.url())
    if (pathname.startsWith('/api/') || pathname.startsWith('/__nuxt_pre_fetch')) requests.push(`${request.method()} ${pathname}${search}`)
  })
  await page.goto(url(path), { waitUntil: 'networkidle' })
  await page.waitForSelector('#learned-source')
  return { page, requests }
}

/** Waits until the page reported what it learned. */
async function learned(page: Page): Promise<void> {
  await page.waitForResponse(response => response.url().includes('/__nuxt_pre_fetch/learn') && response.ok(), { timeout: 10_000 })
}

const browserApiCalls = (requests: string[]) => apiCalls(requests.map(r => r.replace(/^GET /, '')))

describe('learned requests ($nuxtPreFetch.learn / take)', () => {
  it('first visit fetches and reports; the next visit gets the result in the HTML', async () => {
    await resetHits()
    const learning = await open('/learned?q=a', { demo_token: 't1' })
    const { page, requests } = learning
    expect(await text(page, '#learned-source')).toBe('network')
    expect(await text(page, '#learned-auth')).toBe('Bearer t1')
    expect(browserApiCalls(requests)).toEqual(['/api/learned-items?q=a'])
    await learned(page).catch(() => {}) // may already have been sent
    await page.waitForFunction(() => true)
    expect((await hits())['learned-items']).toEqual({ nitro: 0, browser: 1 })

    // Reload in the same browser: Nitro replayed it with THIS request's cookie.
    requests.length = 0
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#learned-source')
    expect(await text(page, '#learned-source')).toBe('learned')
    expect(await text(page, '#learned-auth')).toBe('Bearer t1')
    expect(browserApiCalls(requests)).toEqual([])
    expect((await hits())['learned-items']).toEqual({ nitro: 1, browser: 1 })
    const payload = await page.evaluate(() => document.getElementById('__NUXT_PRE_FETCH__')?.textContent ?? '')
    expect(JSON.parse(payload).runtime).toHaveLength(1)

    // The token is read per request, never stored: a new token is what the replay uses.
    const base = new URL(url('/'))
    await page.context().addCookies([{ name: 'demo_token', value: 't2', domain: base.hostname, path: '/' }])
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('#learned-source')
    expect(await text(page, '#learned-source')).toBe('learned')
    expect(await text(page, '#learned-auth')).toBe('Bearer t2')
    await page.close()
  })

  it('a changed request is fetched normally, and client navigation streams learned pages', async () => {
    const { page, requests } = await open('/learned?q=a')
    await learned(page)
    // Not learned yet: q=b goes to the network (and is reported).
    await page.click('#learned-b')
    await page.waitForFunction(() => document.querySelector('#learned-q')?.textContent === 'b')
    expect(await text(page, '#learned-source')).toBe('network')
    await learned(page)

    // Back to q=a: a learned page, prefetched through the (streamed) endpoint.
    requests.length = 0
    await page.click('#learned-a')
    await page.waitForFunction(() => document.querySelector('#learned-q')?.textContent === 'a')
    expect(await text(page, '#learned-source')).toBe('learned')
    expect(prefetchCalls(requests.map(r => r.replace(/^GET /, ''))).map(decodeURIComponent)).toEqual(['/__nuxt_pre_fetch?path=/learned?q=a&stream=1'])
    expect(browserApiCalls(requests)).toEqual([])
    await page.close()
  })

  it('never replays requests another browser learned', async () => {
    const first = await open('/learned?q=a')
    await learned(first.page)
    await first.page.close()
    const other = await open('/learned?q=a')
    expect(await text(other.page, '#learned-source')).toBe('network')
    await other.page.close()
  })

  it('rejects hosts that are not allowed and cross-site writes', async () => {
    const page = await createPage()
    await page.goto(url('/learned'), { waitUntil: 'networkidle' })
    const status = await page.evaluate(async () => {
      const response = await fetch('/__nuxt_pre_fetch/learn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/learned', visit: 'v1', requests: [{ url: 'https://evil.example.org/x' }, { url: '/api/learned-items', auth: { cookie: 'session' } }] }),
      })
      return { status: response.status, body: await response.json() }
    })
    expect(status).toEqual({ status: 200, body: { accepted: 0, rejected: 2 } })
    await page.close()
  })
})
