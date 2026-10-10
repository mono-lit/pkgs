// LEFT side of /pinia: the same store as stores/team.ts, but with Nuxt's plain useFetch.
// Nothing here is prefetched: the browser calls PokeAPI after Vue boots.
const PICK: Record<ProofResource, string[]> = {
  pokemon: ['id', 'name', 'types'],
  move: ['id', 'name', 'type', 'power', 'accuracy'],
  ability: ['id', 'name', 'generation'],
  item: ['id', 'name', 'cost', 'category'],
}

export const useTeamFetchStore = defineStore('team-fetch', () => {
  const route = useRouter().currentRoute.value
  const testing = route.query.test !== undefined
  const browserRequests = ref(0)
  const countRequest = () => { browserRequests.value++ }

  const items: ProofItem[] = PROOF_RESOURCES.flatMap(({ kind }) =>
    String(route.query[kind] ?? '').split(',').slice(0, 125).map(id => ({
      kind,
      id,
      request: useFetch<Record<string, unknown>>(() => `https://pokeapi.co/api/v2/${kind}/${id}`, {
        key: `team-fetch:${kind}:${id}`, pick: PICK[kind],
        lazy: true, immediate: testing && !!id, cache: 'no-store', onRequest: countRequest,
      }),
    })))

  return { items, browserRequests }
})
