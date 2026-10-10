<script setup lang="ts">
// Performance proof, fetching INSIDE PINIA STORES: LEFT = stores/teamFetch.ts (useFetch),
// RIGHT = stores/team.ts (usePreFetch), one page load (/pinia?pokemon=25&move=14&…&test=<run>).
// This page has no fetch call of its own: the build follows `useTeamStore()` into the
// store, so Nitro prefetches it. Everything else is the same ProofLayout as /performance-proof.

// A new mix (in-place run) remounts the page, so every run sets up fresh stores.
definePageMeta({ key: route => route.fullPath })

const route = useRoute()
const mix = proofMixFromQuery(route.query)
const testing = route.query.test !== undefined && proofMixSize(mix) > 0

const leftStore = useTeamFetchStore()
const rightStore = useTeamStore()

// Pinia sets a store up once per app and reads the URL then, and keeps it (and its data) for
// the app's lifetime. So the stores are disposed
// - before an in-place run: the remounted page creates fresh ones for the new mix, and the
//   browser doesn't report them as active (which would make Nitro skip their prefetch);
// - when leaving this page: coming back starts from empty stores, not the previous run.
const pinia = useNuxtApp().$pinia as { state: { value: Record<string, unknown> }, _s: Map<string, unknown> }
function disposeStores() {
  for (const store of [leftStore, rightStore]) {
    // Only the store this page instance created: never a newer one registered under the same id.
    if (pinia._s.get(store.$id) !== store) continue
    store.$dispose()
    delete pinia.state.value[store.$id]
  }
}
onBeforeRouteLeave(() => disposeStores())

const state = useProofRun({
  storageKey: 'nuxt-pre-fetch:proof:pinia',
  testing,
  sides: {
    useFetch: { statuses: () => proofStatuses(leftStore.items), browserRequests: () => leftStore.browserRequests },
    usePreFetch: { statuses: () => proofStatuses(rightStore.items), browserRequests: () => rightStore.browserRequests },
  },
  describe: () => {
    const items = rightStore.items.filter(item => item.id)
    return { ids: items.map(item => `${item.kind}:${item.id}`), names: items.map(proofItemName), requestsPerSide: items.length }
  },
})

useHead({ title: 'Pinia proof · useFetch vs usePreFetch' })
</script>

<template>
  <ProofLayout
    title="Performance proof with Pinia"
    path="/pinia"
    :state="state"
    :mix="mix"
    :testing="testing"
    :left="leftStore.items"
    :right="rightStore.items"
    left-subtitle="stores/teamFetch.ts: Pinia setup store with useFetch; the browser calls PokeAPI after Vue boots"
    right-subtitle="stores/team.ts: Pinia setup store with usePreFetch; Nitro prefetched it"
    :before-client-run="disposeStores"
  >
    <template #description>
      One page, one page load. The <b>left</b> half gets its data from a Pinia store using Nuxt's <code>useFetch</code>,
      the <b>right</b> half from the same store using <code>usePreFetch</code>. A run is a random mix of four different
      PokeAPI resources (Pokémon, moves, abilities, items). This page only calls <code>useTeamFetchStore()</code> and
      <code>useTeamStore()</code>. Opening the page runs 100 requests in place (pushed to the URL, no reload);
      <b>Run random</b> measures a full page reload. Each half records when <i>all</i> of its data is on screen.
      (<NuxtLink to="/performance-proof">The same proof with the calls directly in the page</NuxtLink>.)
    </template>

    <template #notes>
      <p>
        <b>Pinia:</b> both stores are setup stores (<code>defineStore('id', () =&gt; { … })</code>) and contain exactly
        the calls of <NuxtLink to="/performance-proof">/performance-proof</NuxtLink>. The build follows
        <code>useTeamStore()</code> from this page into <code>stores/team.ts</code>, including its four list queries, so
        Nitro prefetches the store. Inside a store <code>usePreFetch</code> is called without <code>await</code> (Pinia
        setup functions are synchronous), and the URL is read with <code>useRouter().currentRoute.value</code>. A store
        sets up once per app, so this page disposes its stores before each run and when you leave.
      </p>
    </template>
  </ProofLayout>
</template>
