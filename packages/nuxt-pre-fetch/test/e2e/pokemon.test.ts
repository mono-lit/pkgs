import { describe, expect, it } from 'vitest'
import { createPage, fetch, setup, url } from '@nuxt/test-utils/e2e'
import { openPage, playgroundDir, pokeapiCalls, prefetchCalls, text, useDist } from './helpers'

// The Pokémon pages call the real PokeAPI (an allowed external host), so this suite
// needs network access; it is skipped when PokeAPI is unreachable.
const online = await globalThis.fetch('https://pokeapi.co/api/v2/pokemon/1', { method: 'HEAD', signal: AbortSignal.timeout(5000) })
  .then(response => response.ok, () => false)

useDist()

// The proof pages run a random mix of 4 PokeAPI resources, split evenly.
const KINDS = ['pokemon', 'move', 'ability', 'item'] as const
/** A run URL with `n` ids of each resource: `/<page>?pokemon=1,2&move=3,4&ability=5,6&item=7,8&test=<run>`. */
const MIX_URL = (page: string, n: number) => {
  const ids = n === 1 ? '\\d+' : `(\\d+,){${n - 1}}\\d+`
  return new RegExp(`/${page}\\?${KINDS.map(kind => `${kind}=${ids}`).join('&')}&test=\\d+$`)
}
const mixOf = (href: string) => Object.fromEntries(KINDS.map(kind => [kind, new URL(href).searchParams.get(kind)!])) as Record<typeof KINDS[number], string>

if (online) await setup({ rootDir: playgroundDir, server: true, browser: true, build: true, dev: false })

describe.skipIf(!online)('Pokémon pages (external API: pokeapi.co)', () => {
  it('embeds the list page from Nitro — the browser never calls PokeAPI', async () => {
    const response = await fetch('/pokemon')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.text()).toContain('"name":"bulbasaur"')

    const { page, requests } = await openPage('/pokemon')
    expect(await page.locator('#pokemon-list li').count()).toBe(24)
    expect(await text(page, '#pokemon-list li')).toContain('Bulbasaur')
    expect(await text(page, '#pokemon-meta')).toMatch(/page 1 of \d+/)
    expect(pokeapiCalls(requests)).toEqual([])
    expect(prefetchCalls(requests)).toEqual([])
    await page.close()
  })

  it('embeds only the picked keys of the large detail resources', async () => {
    const body = await (await fetch('/pokemon/25')).text()
    const payload = JSON.parse(/id="__NUXT_PRE_FETCH__"[^>]*>(.*?)<\/script>/.exec(body)![1]!)
    const [pokemon, species] = Object.values(payload.entries) as Array<{ d: Record<string, unknown> }>
    expect(Object.keys(pokemon!.d)).toEqual(['id', 'name', 'height', 'weight', 'base_experience', 'types', 'stats', 'abilities'])
    expect(pokemon!.d).not.toHaveProperty('moves')
    expect(Object.keys(species!.d)).toContain('flavor_text_entries')
  })

  it('pages through the list via the prefetch endpoint (query change on the same page)', async () => {
    const { page, requests } = await openPage('/pokemon')
    await page.click('#pokemon-next')
    await page.waitForFunction(() => document.querySelector('#pokemon-list li')?.textContent?.includes('Pikachu'))
    expect(page.url()).toContain('/pokemon?offset=24')
    expect(prefetchCalls(requests).map(decodeURIComponent)).toEqual(['/__nuxt_pre_fetch?path=/pokemon?offset=24&stream=1'])
    expect(pokeapiCalls(requests)).toEqual([])
    await page.close()
  })

  it('opens a detail page and walks to the next Pokémon through Nitro', async () => {
    const { page, requests } = await openPage('/pokemon?offset=24')
    await page.click('text=Pikachu')
    await page.waitForSelector('#pokemon-name')
    expect(await text(page, '#pokemon-name')).toBe('Pikachu')
    expect(await text(page, '#pokemon-genus')).toBe('Mouse Pokémon')
    expect(await page.locator('#pokemon-types li').allTextContents()).toEqual(['electric'])
    expect(await page.locator('#pokemon-stats dt').count()).toBe(6)

    await page.click('#pokemon-next')
    await page.waitForFunction(() => document.querySelector('#pokemon-name')?.textContent === 'Raichu')
    expect(prefetchCalls(requests).map(decodeURIComponent)).toEqual(['/__nuxt_pre_fetch?path=/pokemon/25&stream=1', '/__nuxt_pre_fetch?path=/pokemon/26&stream=1'])
    expect(pokeapiCalls(requests)).toEqual([])

    await page.click('#pokemon-back')
    await page.waitForFunction(() => document.querySelector('#pokemon-list li')?.textContent?.includes('Pikachu'))
    expect(pokeapiCalls(requests)).toEqual([])
    await page.close()
  })

  it('finds a Pokémon by name from the search box', async () => {
    const { page, requests } = await openPage('/pokemon')
    await page.fill('#pokemon-search', 'Mr Mime')
    await page.press('#pokemon-search', 'Enter')
    await page.waitForFunction(() => document.querySelector('#pokemon-name')?.textContent === 'Mr Mime')
    expect(pokeapiCalls(requests)).toEqual([])
    await page.close()
  })

  it('/performance-proof runs automatically when opened, and measures both halves in one real page load', async () => {
    // `?count=4` instead of the default 100: one random id of each PokeAPI resource.
    const { page, requests } = await openPage('/performance-proof?count=4')
    // No click: opening the page started an in-place run (no reload): the mix + test=<run> was pushed onto the route.
    await page.waitForURL(MIX_URL('performance-proof', 1), { timeout: 60_000 })
    const mix = mixOf(page.url())
    await page.waitForSelector('#proof-runs tbody tr', { timeout: 60_000 })
    const names = await page.locator('.proof-side--usePreFetch .proof-mix__group li b').allInnerTexts()
    expect(names).toHaveLength(4)
    expect(await page.locator('.proof-side--useFetch .proof-mix__group li b').allInnerTexts()).toEqual(names)
    for (const kind of KINDS) expect(await page.locator(`.proof-side--usePreFetch .proof-mix__group--${kind} li`).count()).toBe(1)
    // Browser data requests: the useFetch half calls PokeAPI once per request, the usePreFetch half never.
    expect(await text(page, '#proof-metrics-useFetch')).toMatch(/Browser data requests\s+4/)
    const right = await text(page, '#proof-metrics-usePreFetch')
    expect(right).toMatch(/Browser data requests\s+0/)
    // In place: the right half's data came through the prefetch endpoint (not the HTML).
    expect(right).toMatch(/Prefetch payload\s+[\d.]+ KB/)
    expect(right).toMatch(/Nitro prefetch \(endpoint\)\s+\d+ ms/)
    expect(await page.locator('#proof-not-prefetched').count()).toBe(0)
    expect(pokeapiCalls(requests).sort()).toEqual(KINDS.map(kind => `pokeapi:/api/v2/${kind}/${mix[kind]}`).sort())
    expect(await text(page, '#proof-runs tbody tr')).toMatch(/in place\s+warmed/)

    // A browser reload of the run page is measured again as a new run (no second navigation).
    const before = page.url()
    await page.reload()
    await page.waitForFunction(() => document.querySelectorAll('#proof-runs tbody tr').length === 2, null, { timeout: 60_000 })
    expect(page.url()).toBe(before)
    expect(await text(page, '#proof-runs tbody tr')).toMatch(/page load\s+cold/)
    expect(await text(page, '#proof-metrics-usePreFetch')).toMatch(/Embedded payload\s+[\d.]+ KB/) // in the HTML now
    await page.close()
  })

  it('/performance-proof with N random requests runs in place (no reload); only Run random reloads', async () => {
    const page = await createPage()
    // Real page loads = HTML document requests (router history updates don't count).
    const documents: string[] = []
    page.on('request', (request) => {
      if (request.resourceType() === 'document' && request.frame() === page.mainFrame()) documents.push(new URL(request.url()).pathname + new URL(request.url()).search)
    })
    await page.goto(url('/performance-proof?count=12')) // 3 of each resource
    await page.waitForURL(MIX_URL('performance-proof', 3), { timeout: 60_000 })
    await page.waitForSelector('#proof-runs tbody tr', { timeout: 60_000 })
    expect(documents).toHaveLength(1) // in place: no reload
    expect(await page.locator('.proof-side--usePreFetch .proof-mix__group li b').count()).toBe(12)
    expect(await page.locator('.proof-side--useFetch .proof-mix__group li b').count()).toBe(12)
    expect(await text(page, '#proof-metrics-useFetch')).toMatch(/Browser data requests\s+12/)
    expect(await text(page, '#proof-metrics-usePreFetch')).toMatch(/Browser data requests\s+0/)
    expect(await page.inputValue('#proof-count')).toBe('12')
    expect(await text(page, '#proof-runs tbody tr td:nth-child(2)')).toBe('12')

    // "Run random" is the one thing that reloads the page.
    await page.fill('#proof-count', '1')
    await page.click('#proof-run-random')
    await page.waitForFunction(() => document.querySelector('#proof-runs tbody tr td:nth-child(3)')?.textContent === 'page load', null, { timeout: 60_000 })
    expect(documents).toHaveLength(2)
    await page.close()
  })

  it('/performance-proof defaults to 100 random requests and a tab click starts a run in place', async () => {
    const page = await createPage()
    await page.goto(url('/'), { waitUntil: 'networkidle' })
    // Hold the run before anything reaches PokeAPI: the warm-up never answers. We only check
    // what the tab click started (100 requests) and that it didn't reload the page.
    const documents: string[] = []
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documents.push(request.url())
    })
    const warmed: Array<{ urls: string[] }> = []
    await page.route('**/api/proof-warm', (route) => { warmed.push(route.request().postDataJSON()) })
    await page.click('#nav-proof')
    await page.waitForSelector('#proof-preparing')
    expect(await page.inputValue('#proof-count')).toBe('100')
    expect(await text(page, '#proof-preparing')).toContain('100 PokeAPI requests')
    // 25 of each resource, all different URLs.
    await expect.poll(() => warmed.length).toBe(1)
    const urls = warmed[0]!.urls
    expect(new Set(urls).size).toBe(100)
    for (const kind of KINDS) expect(urls.filter(u => u.startsWith(`https://pokeapi.co/api/v2/${kind}/`))).toHaveLength(25)
    expect(documents).toEqual([])
    await page.close()
  })

  it('shows a not-found state for unknown Pokémon (the 404 the server got is retried by the browser)', async () => {
    const { page, requests } = await openPage('/pokemon/not-a-pokemon')
    expect(await text(page, '#pokemon-error h1')).toBe('Pokémon not found')
    expect(pokeapiCalls(requests).sort()).toEqual(['pokeapi:/api/v2/pokemon-species/not-a-pokemon', 'pokeapi:/api/v2/pokemon/not-a-pokemon'])
    await page.close()
  })
})

describe.skipIf(!online)('/pinia: the same proof with usePreFetch inside a Pinia store', () => {
  it('runs automatically; the usePreFetch store is prefetched, only the useFetch store calls PokeAPI', async () => {
    const { page, requests } = await openPage('/pinia?count=4')
    await page.waitForURL(MIX_URL('pinia', 1), { timeout: 60_000 })
    const mix = mixOf(page.url())
    await page.waitForSelector('#proof-runs tbody tr', { timeout: 60_000 })
    const names = await page.locator('.proof-side--usePreFetch .proof-mix__group li b').allInnerTexts()
    expect(names).toHaveLength(4)
    expect(await page.locator('.proof-side--useFetch .proof-mix__group li b').allInnerTexts()).toEqual(names)
    expect(await text(page, '#proof-metrics-useFetch')).toMatch(/Browser data requests\s+4/)
    expect(await text(page, '#proof-metrics-usePreFetch')).toMatch(/Browser data requests\s+0/)
    expect(await page.locator('#proof-not-prefetched').count()).toBe(0)
    expect(pokeapiCalls(requests).sort()).toEqual(KINDS.map(kind => `pokeapi:/api/v2/${kind}/${mix[kind]}`).sort())
    await page.close()
  })

  it('runs N random requests in place, with fresh stores (not skipped as active)', async () => {
    const page = await createPage()
    const endpointCalls: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/__nuxt_pre_fetch')) endpointCalls.push(decodeURIComponent(request.url()))
    })
    await page.goto(url('/pinia?count=8'))
    await page.waitForURL(MIX_URL('pinia', 2), { timeout: 60_000 })
    await page.waitForSelector('#proof-runs tbody tr', { timeout: 60_000 })
    expect(await page.locator('.proof-side--usePreFetch .proof-mix__group li b').count()).toBe(8)
    expect(await page.locator('.proof-side--useFetch .proof-mix__group li b').count()).toBe(8)
    expect(await text(page, '#proof-metrics-useFetch')).toMatch(/Browser data requests\s+8/)
    expect(await text(page, '#proof-metrics-usePreFetch')).toMatch(/Browser data requests\s+0/)
    expect(endpointCalls.some(call => call.includes('skipStores'))).toBe(false)
    await page.close()
  })

  it('coming back to /pinia starts from empty stores: the previous run is not shown again', async () => {
    const { page } = await openPage('/pinia?count=4')
    await page.waitForFunction(() => location.search.includes('pokemon=') && !!document.querySelector('#proof-runs tbody tr'), null, { timeout: 60_000 })
    expect(await page.locator('.proof-side--usePreFetch .proof-mix__group li b').count()).toBe(4)
    await page.click('text=Home')
    await page.waitForSelector('h1:has-text("playground")')
    // Hold the next run's warm-up (nothing reaches PokeAPI) to see what the page shows meanwhile.
    await page.route('**/api/proof-warm', () => {})
    const endpointCalls: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/__nuxt_pre_fetch')) endpointCalls.push(decodeURIComponent(request.url()))
    })
    await page.click('#nav-pinia')
    await page.waitForSelector('#proof-preparing')
    expect(await page.locator('.proof-side--usePreFetch .proof-mix__group li').count()).toBe(0)
    expect(await page.locator('.proof-side--useFetch .proof-mix__group li').count()).toBe(0)
    expect(await text(page, '.proof-side--usePreFetch .proof-mix__placeholder')).toBe('starting a run…')
    expect(endpointCalls.some(call => call.includes('skipStores'))).toBe(false) // no stale "active" stores
    await page.close()
  })

  it('the prefetch endpoint expands every resource list of the store, and skips stores the browser reports as active', async () => {
    const path = encodeURIComponent('/pinia?pokemon=25&move=1&ability=65&item=1')
    const full = await (await fetch(`/__nuxt_pre_fetch?path=${path}`)).json()
    expect(Object.keys(full.entries)).toHaveLength(4) // one per resource, from the usePreFetch store
    const skipped = await (await fetch(`/__nuxt_pre_fetch?path=${path}&skipStores=team`)).json()
    expect(Object.keys(skipped.entries)).toEqual([])
  })
})
