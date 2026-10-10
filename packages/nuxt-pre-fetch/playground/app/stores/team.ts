// RIGHT side of /pinia: the performance-proof mix (Pokémon, moves, abilities, items), fetched
// with usePreFetch inside a Pinia setup store. The page only calls `useTeamStore()`; the build
// follows that call into this file and understands its four list queries, so Nitro
// prefetches every request.
//
// Pinia runs a store's setup once per app, so the mix comes from the URL when the store is
// created (the page disposes the store before each in-place run and when leaving).
export const useTeamStore = defineStore('team', () => {
  // `useRouter().currentRoute`, not `useRoute()`: a store has no page context, and Nuxt's
  // fallback route only updates after the new page rendered (in-place runs would see the
  // previous URL). The build understands both forms.
  const route = useRouter().currentRoute.value
  const testing = route.query.test !== undefined
  // Demo instrumentation: requests this store really sent from the browser (prefetched: none).
  const browserRequests = ref(0)
  const countRequest = () => { browserRequests.value++ }

  // `.slice(0, 125)` = PROOF_MAX_PER_RESOURCE (500 requests per side).
  const items: ProofItem[] = [
    ...String(route.query.pokemon ?? '').split(',').slice(0, 125).map(id => ({
      kind: 'pokemon' as const,
      id,
      request: usePreFetch<Record<string, unknown>>(() => `https://pokeapi.co/api/v2/pokemon/${id}`, {
        key: `team:pokemon:${id}`, pick: ['id', 'name', 'types'],
        lazy: true, immediate: testing && !!id, cache: 'no-store', onRequest: countRequest,
      }),
    })),
    ...String(route.query.move ?? '').split(',').slice(0, 125).map(id => ({
      kind: 'move' as const,
      id,
      request: usePreFetch<Record<string, unknown>>(() => `https://pokeapi.co/api/v2/move/${id}`, {
        key: `team:move:${id}`, pick: ['id', 'name', 'type', 'power', 'accuracy'],
        lazy: true, immediate: testing && !!id, cache: 'no-store', onRequest: countRequest,
      }),
    })),
    ...String(route.query.ability ?? '').split(',').slice(0, 125).map(id => ({
      kind: 'ability' as const,
      id,
      request: usePreFetch<Record<string, unknown>>(() => `https://pokeapi.co/api/v2/ability/${id}`, {
        key: `team:ability:${id}`, pick: ['id', 'name', 'generation'],
        lazy: true, immediate: testing && !!id, cache: 'no-store', onRequest: countRequest,
      }),
    })),
    ...String(route.query.item ?? '').split(',').slice(0, 125).map(id => ({
      kind: 'item' as const,
      id,
      request: usePreFetch<Record<string, unknown>>(() => `https://pokeapi.co/api/v2/item/${id}`, {
        key: `team:item:${id}`, pick: ['id', 'name', 'cost', 'category'],
        lazy: true, immediate: testing && !!id, cache: 'no-store', onRequest: countRequest,
      }),
    })),
  ]

  return { items, browserRequests }
})
