import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright-core'
import { $fetch, createPage, url } from '@nuxt/test-utils/e2e'

export const playgroundDir: string = fileURLToPath(new URL('../../playground', import.meta.url))

/** e2e runs against the built package, like a consumer would install it. */
export function useDist(): void {
  if (!existsSync(fileURLToPath(new URL('../../dist/module.mjs', import.meta.url)))) {
    throw new Error('dist/ is missing: run `pnpm build` (tsdown) before the e2e tests')
  }
  process.env.NUXT_PRE_FETCH_DIST = '1'
}

export type Hits = Record<string, { nitro: number, browser: number }>

export async function resetHits(): Promise<void> {
  await $fetch('/api/hits?reset')
}

export async function hits(): Promise<Hits> {
  return $fetch<Hits>('/api/hits')
}

/**
 * Opens a page and records every request the BROWSER makes to `/api/*`, the prefetch
 * endpoint, or PokeAPI (recorded as `pokeapi:/api/v2/...`).
 */
export async function openPage(path: string, contextOptions?: Parameters<typeof createPage>[1]): Promise<{ page: Page, requests: string[] }> {
  const page = await createPage(undefined, contextOptions)
  const requests: string[] = []
  page.on('request', (request) => {
    const { host, pathname, search } = new URL(request.url())
    if (host === 'pokeapi.co') requests.push(`pokeapi:${pathname}${search}`)
    else if (pathname.startsWith('/api/') || pathname.startsWith('/__nuxt_pre_fetch')) requests.push(pathname + search)
  })
  await page.goto(url(path), { waitUntil: 'networkidle' })
  return { page, requests }
}

export const apiCalls = (requests: string[]): string[] => requests.filter(r => r.startsWith('/api/'))
export const pokeapiCalls = (requests: string[]): string[] => requests.filter(r => r.startsWith('pokeapi:'))
export const prefetchCalls = (requests: string[]): string[] => requests.filter(r => r.startsWith('/__nuxt_pre_fetch'))

export async function text(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).first().innerText()).trim()
}
