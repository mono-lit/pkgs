// `NUXT_PRE_FETCH_DIST=1` runs the playground against the built package
// (`dist/`, what users install); otherwise against the TypeScript sources.
const prefetchModule = process.env.NUXT_PRE_FETCH_DIST ? '../dist/module.mjs' : '../src/module'

export default defineNuxtConfig({
  ssr: false,
  modules: ['@pinia/nuxt', prefetchModule],
  compatibilityDate: '2026-08-01',
  devtools: { enabled: false },
  nuxtPreFetch: {
    debug: !!process.env.NUXT_PRE_FETCH_DEBUG,
    keepPayload: true,
    fetchMode: process.env.NUXT_PRE_FETCH_MODE === 'server' ? 'server' : 'client',
    // The Pokémon pages prefetch from PokeAPI. External hosts are opt-in; no
    // incoming headers/cookies are forwarded to it (no forwardHeaders entry).
    external: { allowedHosts: ['pokeapi.co'] },
    // The proof pages take up to 125 ids in each of `?pokemon=&move=&ability=&item=` (500
    // PokeAPI requests per side; the pages also slice to 125). Library default: 20. More
    // parallel server requests too.
    maxListItems: 125,
    concurrency: 16,
    // /declared (app/prefetch/declared.ts) and /learned: runtime-built requests — declared ones
    // run on the first visit, learned ones are reported by the page and replayed on the next.
    // `demo_token` may become its `Authorization: Bearer` (read per request, never stored).
    dynamic: { authCookies: ['demo_token'] },
    learn: { enabled: true },
  },
  // Type-check the module runtime as part of the playground (client and Nitro parts separately).
  typescript: {
    tsConfig: { include: ['../../src/runtime/**/*'], exclude: ['../../src/runtime/server/**/*'] },
  },
  nitro: {
    typescript: {
      tsConfig: { include: ['../../src/runtime/server/**/*', '../../src/runtime/shared/**/*'] },
    },
  },
})
