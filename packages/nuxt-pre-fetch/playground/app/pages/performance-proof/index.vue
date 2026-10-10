<script setup lang="ts">
// Performance proof, fetching DIRECTLY IN THE PAGE: LEFT = Nuxt's useFetch, RIGHT =
// usePreFetch, one page load (/performance-proof?pokemon=25,6&move=14&ability=65&item=17&test=<run>).
// A run is a random mix of 4 PokeAPI resources. Everything else (controls, measuring,
// results, notes) is the shared ProofLayout; /pinia is the same page with the fetching
// moved into Pinia stores.

// A new mix (in-place run) remounts the page, so every run sets up fresh composables.
definePageMeta({ key: route => route.fullPath })

const route = useRoute()
const mix = proofMixFromQuery(route.query)
const testing = route.query.test !== undefined && proofMixSize(mix) > 0

// Requests each side really sends from the browser (prefetched data sends none).
const sent = reactive<Record<ProofMode, number>>({ useFetch: 0, usePreFetch: 0 })
const countLeft = () => { sent.useFetch++ }
const countRight = () => { sent.usePreFetch++ }

// Keys each resource keeps (trimmed on the server for usePreFetch, in the browser for useFetch).
const PICK: Record<ProofResource, string[]> = {
  pokemon: ['id', 'name', 'types'],
  move: ['id', 'name', 'type', 'power', 'accuracy'],
  ability: ['id', 'name', 'generation'],
  item: ['id', 'name', 'cost', 'category'],
}

// LEFT: plain useFetch for every request, all started together (`lazy`: nothing blocks the
// page, so neither half waits for the other).
const left: ProofItem[] = PROOF_RESOURCES.flatMap(({ kind }) =>
  String(route.query[kind] ?? '').split(',').slice(0, 125).map(id => ({
    kind,
    id,
    request: useFetch<Record<string, unknown>>(() => `https://pokeapi.co/api/v2/${kind}/${id}`, {
      key: `proof:left:${kind}:${id}`, pick: PICK[kind],
      lazy: true, immediate: testing && !!id, cache: 'no-store', onRequest: countLeft,
    }),
  })))

// RIGHT: the same requests with usePreFetch, one list query per resource (`?pokemon=…&move=…`),
// written out so the build understands them: Nitro expands each list into one prefetch per id.
// `.slice(0, 125)` = PROOF_MAX_PER_RESOURCE (500 requests per side).
const right: ProofItem[] = [
  ...String(route.query.pokemon ?? '').split(',').slice(0, 125).map(id => ({
    kind: 'pokemon' as const,
    id,
    request: usePreFetch<Record<string, unknown>>(() => `https://pokeapi.co/api/v2/pokemon/${id}`, {
      key: `proof:right:pokemon:${id}`, pick: ['id', 'name', 'types'],
      lazy: true, immediate: testing && !!id, cache: 'no-store', onRequest: countRight,
    }),
  })),
  ...String(route.query.move ?? '').split(',').slice(0, 125).map(id => ({
    kind: 'move' as const,
    id,
    request: usePreFetch<Record<string, unknown>>(() => `https://pokeapi.co/api/v2/move/${id}`, {
      key: `proof:right:move:${id}`, pick: ['id', 'name', 'type', 'power', 'accuracy'],
      lazy: true, immediate: testing && !!id, cache: 'no-store', onRequest: countRight,
    }),
  })),
  ...String(route.query.ability ?? '').split(',').slice(0, 125).map(id => ({
    kind: 'ability' as const,
    id,
    request: usePreFetch<Record<string, unknown>>(() => `https://pokeapi.co/api/v2/ability/${id}`, {
      key: `proof:right:ability:${id}`, pick: ['id', 'name', 'generation'],
      lazy: true, immediate: testing && !!id, cache: 'no-store', onRequest: countRight,
    }),
  })),
  ...String(route.query.item ?? '').split(',').slice(0, 125).map(id => ({
    kind: 'item' as const,
    id,
    request: usePreFetch<Record<string, unknown>>(() => `https://pokeapi.co/api/v2/item/${id}`, {
      key: `proof:right:item:${id}`, pick: ['id', 'name', 'cost', 'category'],
      lazy: true, immediate: testing && !!id, cache: 'no-store', onRequest: countRight,
    }),
  })),
]

const state = useProofRun({
  storageKey: 'nuxt-pre-fetch:performance-proof',
  testing,
  sides: {
    useFetch: { statuses: () => proofStatuses(left), browserRequests: () => sent.useFetch },
    usePreFetch: { statuses: () => proofStatuses(right), browserRequests: () => sent.usePreFetch },
  },
  describe: () => {
    const items = right.filter(item => item.id)
    return { ids: items.map(item => `${item.kind}:${item.id}`), names: items.map(proofItemName), requestsPerSide: items.length }
  },
})

useHead({ title: 'Performance proof · useFetch vs usePreFetch' })
</script>

<template>
  <ProofLayout
    title="Performance proof"
    path="/performance-proof"
    :state="state"
    :mix="mix"
    :testing="testing"
    :left="left"
    :right="right"
    left-subtitle="normal SPA: Vue boots, then the browser calls PokeAPI"
    right-subtitle="Nitro called PokeAPI while producing this HTML"
  >
    <template #description>
      One page, one page load. The <b>left</b> half gets its data with Nuxt's <code>useFetch</code>, the <b>right</b>
      half with <code>usePreFetch</code>, called directly in this page. A run is a random mix of four different PokeAPI
      resources (Pokémon, moves, abilities, items), split evenly. Opening the page runs 100 requests in place (pushed
      to the URL, no reload); <b>Run random</b> measures a full page reload. Each half records when <i>all</i> of its
      data is on screen. (<NuxtLink to="/pinia">The same proof with Pinia stores</NuxtLink>.)
    </template>
  </ProofLayout>
</template>
