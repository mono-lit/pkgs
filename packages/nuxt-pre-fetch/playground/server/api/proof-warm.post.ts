// Proof-page warm-up (playground only). Fetches every PokeAPI URL of a run once from the
// SERVER, right before the measured reload. That warms PokeAPI's CDN cache for both sides
// and leaves Nitro's connections to pokeapi.co open (Node keeps idle connections ~4 s), like
// a server that has traffic. Without it, Nitro would pay a cold cache + a fresh TLS handshake
// that the browser half doesn't (it reuses its open HTTP/2 connection from earlier runs).
//
// Body: `{ ids: ['25', 'pikachu'] }` (pokemon + species per id) and/or
//       `{ urls: ['https://pokeapi.co/api/v2/type'] }` (PokeAPI URLs only: never a proxy).
const POKEAPI_URL = /^https:\/\/pokeapi\.co\/api\/v2\/[\w\-/]*(?:\?[\w=&-]*)?$/

export default defineEventHandler(async (event) => {
  const { ids = [], urls: extra = [] } = await readBody<{ ids?: unknown, urls?: unknown }>(event)
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id))) {
    throw createError({ statusCode: 400, statusMessage: 'ids must be Pokémon ids or names' })
  }
  if (!Array.isArray(extra) || !extra.every(url => typeof url === 'string' && POKEAPI_URL.test(url)) || extra.length > 500) {
    throw createError({ statusCode: 400, statusMessage: 'urls must be PokeAPI URLs' })
  }
  // Same cap as the proof pages: at most 250 Pokémon (500 requests) per run.
  const urls = [
    ...(ids as string[]).slice(0, 250).flatMap(id => [`https://pokeapi.co/api/v2/pokemon/${id}`, `https://pokeapi.co/api/v2/pokemon-species/${id}`]),
    ...extra as string[],
  ]
  const startedAt = performance.now()
  let next = 0
  await Promise.all(Array.from({ length: Math.min(16, urls.length) }, async () => {
    while (next < urls.length) {
      const url = urls[next++]!
      await $fetch(url, { responseType: 'arrayBuffer', retry: 0 }).catch(() => undefined)
    }
  }))
  return { requests: urls.length, ms: Math.round(performance.now() - startedAt) }
})
