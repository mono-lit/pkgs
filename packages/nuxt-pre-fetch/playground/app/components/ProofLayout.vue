<script setup lang="ts">
// The whole proof page, identical on every proof page: title + description, the run
// controls (random mix of PokeAPI requests), the "not prefetched" warning, the summary, LEFT (useFetch) | RIGHT
// (usePreFetch), the runs table, "How to read it" and the recorded benchmark.
// A page only provides where its data comes from: the two sides' requests (`left` / `right`).
const props = defineProps<{
  title: string
  /** Page to reload into when running (`/performance-proof`, `/pinia`). */
  path: string
  state: ProofRunState
  /** The current run's mix (from the URL). */
  mix: ProofMix
  testing: boolean
  left: ProofItem[]
  right: ProofItem[]
  leftSubtitle: string
  rightSubtitle: string
  /** Runs right before an in-place run changes the route (Pinia: dispose the old stores). */
  beforeClientRun?: () => void
}>()

const size = computed(() => proofMixSize(props.mix))
const sideDetail = computed(() => props.testing && size.value
  ? ` · ${size.value} requests (${PROOF_RESOURCES.map(resource => `${props.mix[resource.kind].length} ${resource.label.toLowerCase()}`).join(', ')})`
  : '')
</script>

<template>
  <main class="proof-layout">
    <header class="proof-layout__header">
      <h1>{{ title }}</h1>
      <p><slot name="description" /></p>
    </header>

    <div class="proof-layout__controls">
      <ProofControls :path="path" :size="size" :testing="testing" :can-clear="state.runs.value.length > 0" :before-client-run="beforeClientRun" @clear="state.clear" />
    </div>

    <p v-if="state.notPrefetched.value" id="proof-not-prefetched" class="proof-layout__warning" role="alert">
      <b>This run was not prefetched by the server.</b> Neither the HTML nor the prefetch endpoint carried
      <code>Server-Timing: nuxt-pre-fetch</code>, so the right half fetched from the browser like <code>useFetch</code>, and this run is not a valid comparison.
      Usually the dev server is running an older build of the module: restart <code>pnpm dev</code> (module code is not hot-reloaded).
    </p>

    <ProofSummary :runs="state.runs.value" />

    <div class="proof-layout__sides">
      <ProofSide mode="useFetch" :subtitle="leftSubtitle + sideDetail" :run="state.shown.value">
        <ProofMixView :items="left" :testing="testing" />
      </ProofSide>
      <ProofSide mode="usePreFetch" :subtitle="rightSubtitle + sideDetail" :run="state.shown.value">
        <ProofMixView :items="right" :testing="testing" />
      </ProofSide>
    </div>

    <ProofRunsTable :runs="state.runs.value" :shown-run="state.shown.value?.run" />
    <ProofNotes><slot name="notes" /></ProofNotes>
    <ProofBenchmark />
  </main>
</template>

<style scoped>
.proof-layout { max-width: 1280px; margin: 0 auto; padding: 1.5rem 1rem 3rem; font-family: system-ui, sans-serif; }
.proof-layout__header h1 { margin: 0 0 .25rem; }
.proof-layout__header p { margin: 0; max-width: 56rem; color: #444; line-height: 1.5; }
.proof-layout__controls { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-top: 1rem; padding: .75rem 1rem; border-radius: 12px; background: #f6f7f9; }
.proof-layout__warning { margin: 1rem 0 0; padding: .9rem 1.1rem; border-radius: 12px; background: #fdecea; color: #7a1c13; line-height: 1.5; }
.proof-layout__sides { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1.25rem; }
@media (max-width: 900px) { .proof-layout__sides { grid-template-columns: 1fr; } }
</style>
