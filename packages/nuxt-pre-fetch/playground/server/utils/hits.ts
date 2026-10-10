import type { H3Event } from 'h3'

/** Per-endpoint request counters, split by who called: Nitro (prefetch) or the browser. */
const hits: Record<string, { nitro: number, browser: number }> = {}

export function recordHit(event: H3Event, name: string): void {
  const counter = (hits[name] ??= { nitro: 0, browser: 0 })
  if (getRequestHeader(event, 'x-nuxt-pre-fetch')) counter.nitro++
  else counter.browser++
}

export function readHits(): typeof hits {
  return hits
}

export function resetHits(): void {
  for (const key of Object.keys(hits)) delete hits[key]
}
