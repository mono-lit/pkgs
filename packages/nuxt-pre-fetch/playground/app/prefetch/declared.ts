// /declared: the page builds its request at RUNTIME (from a cookie, in onMounted), so the
// build can't discover it. Declaring it here lets Nitro fetch it on the very first request.
export default definePrefetch('/declared', ctx => [
  {
    url: '/api/learned-items',
    query: { q: ctx.cookie('demo_q') ?? 'a' },
    auth: ctx.cookie('demo_token') ? { cookie: 'demo_token' } : undefined,
  },
])
