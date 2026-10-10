// Target of the /learned and /declared pages: a request built at runtime (invisible to the
// build). Echoes the query and the bearer it was called with. `q=server-down` fails ONLY for
// Nitro's prefetch (503) — the browser's retry then succeeds — to show a server-side failure
// being retried by the client.
export default defineEventHandler((event) => {
  recordHit(event, 'learned-items')
  const { q } = getQuery(event)
  if (q === 'server-down' && getRequestHeader(event, 'x-nuxt-pre-fetch')) {
    throw createError({ statusCode: 503, statusMessage: 'Unavailable for the prefetch' })
  }
  return { q: String(q ?? ''), auth: getRequestHeader(event, 'authorization') ?? null, at: Date.now() }
})
