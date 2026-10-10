import { beforeEach, describe, expect, it } from 'vitest'
import { setup } from '@nuxt/test-utils/e2e'
import { apiCalls, hits, openPage, playgroundDir, prefetchCalls, resetHits, text, useDist } from './helpers'

useDist()

// Same production build, `fetchMode: 'server'` and `keepPayload` switched on through runtime config.
await setup({
  rootDir: playgroundDir,
  server: true,
  browser: true,
  build: true,
  dev: false,
  env: { NUXT_PUBLIC_NUXT_PRE_FETCH_FETCH_MODE: 'server', NUXT_PUBLIC_NUXT_PRE_FETCH_KEEP_PAYLOAD: 'true' },
})

beforeEach(resetHits)

describe('keepPayload: true', () => {
  it('leaves the JSON element in the DOM after the client has used it', async () => {
    const { page, requests } = await openPage('/dashboard')
    expect(await text(page, '#users')).toBe('Ada\nGrace')
    const kept = await page.locator('#__NUXT_PRE_FETCH__').textContent()
    expect(JSON.parse(kept!)).toMatchObject({ v: 1, path: '/dashboard' })
    expect(apiCalls(requests)).toEqual([])
    await page.close()
  })
})

describe('fetchMode: server', () => {
  it('refresh() runs on Nitro — the browser never calls the API', async () => {
    const { page, requests } = await openPage('/dashboard')
    const before = Number(await text(page, '#time'))
    await page.click('#refresh-time')
    await page.waitForFunction(n => Number(document.querySelector('#time')?.textContent) > n, before)
    await page.click('#refresh-users')
    await page.waitForLoadState('networkidle')
    expect(apiCalls(requests)).toEqual([])
    expect(prefetchCalls(requests)).toHaveLength(2)
    expect(prefetchCalls(requests).every(r => /[?&]id=[\da-f]{16}/.test(r))).toBe(true)
    expect(await hits()).toMatchObject({ users: { nitro: 2, browser: 0 }, time: { nitro: 2, browser: 0 } })
    await page.close()
  })

  it('a request Nitro cannot run falls back to the browser (fallback: client)', async () => {
    const { page, requests } = await openPage('/edge-cases')
    expect(await text(page, '#dynamic')).toBe('1')
    // Asked the endpoint first (not in the manifest), then fetched from the browser. The 403 the
    // server got for /api/forbidden is retried by the browser too (serverErrors: 'retry').
    expect(apiCalls(requests).sort()).toEqual(['/api/forbidden', '/api/products'])
    expect(prefetchCalls(requests)).toHaveLength(1)
    await page.close()
  })
})
