<script setup lang="ts">
// The run controls shared by every proof page: N random requests (default 100, at most
// PROOF_MAX_REQUESTS per side), split evenly over 4 PokeAPI resources (Pokémon, moves,
// abilities, items); an optional server warm-up; Clear.
//
// Arriving on the page without a run (tab/nav link, or a bare URL) starts an IN-PLACE run
// right away: no reload, the mix is pushed onto the route and both sides fetch.
// Only "Run random" reloads the page. A browser reload of a run page is measured as a new
// run (useProofRun).
const props = defineProps<{
  /** Page to run on, e.g. `/performance-proof` or `/pinia`. */
  path: string
  /** Requests of the current run (to prefill the count). */
  size: number
  /** This page load is a run (`?test=`). */
  testing: boolean
  /** Show "Clear" (there are stored runs). */
  canClear?: boolean
  /** Runs right before an in-place run changes the route (Pinia: dispose the old stores). */
  beforeClientRun?: () => void
}>()
const emit = defineEmits<{ clear: [] }>()

const DEFAULT_COUNT = 100
const route = useRoute()
const clamp = (value: unknown) => Math.min(PROOF_MAX_REQUESTS, Math.max(1, Math.floor(Number(value) || 1)))
const requested = typeof route.query.count === 'string' ? clamp(route.query.count) : undefined
const randomCount = ref(requested ?? (props.size ? clamp(props.size) : DEFAULT_COUNT))
const warm = ref(true)
const preparing = ref('')

const nextMix = () => {
  randomCount.value = clamp(randomCount.value)
  return randomProofMix(randomCount.value)
}

async function runRandom() {
  if (preparing.value) return
  const mix = nextMix()
  preparing.value = warm.value ? `warming up ${proofMixSize(mix)} PokeAPI requests on the server…` : 'reloading…'
  await reloadForProof(props.path, mix, warm.value)
}

/** An in-place run (no reload): a new random mix pushed onto the route, fetched right away. */
async function runInPlace() {
  if (preparing.value) return
  const mix = nextMix()
  preparing.value = warm.value ? `warming up ${proofMixSize(mix)} PokeAPI requests on the server…` : 'starting…'
  await runProofInPlace(props.path, mix, warm.value, props.beforeClientRun)
}

onMounted(() => {
  // No run on this URL yet: start one in place. Wait until the app is ready, so the route
  // change is a regular client navigation (prefetched through the endpoint).
  if (!props.testing) onNuxtReady(runInPlace)
})
</script>

<template>
  <form class="proof-controls" @submit.prevent="runRandom">
    <label class="proof-controls__count">
      <input
        id="proof-count"
        v-model.number="randomCount"
        type="number"
        min="1"
        :max="PROOF_MAX_REQUESTS"
        step="1"
        :disabled="!!preparing"
        @change="randomCount = clamp(randomCount)"
      >
      random requests <small>(Pokémon · moves · abilities · items, max {{ PROOF_MAX_REQUESTS }} per side)</small>
    </label>
    <button id="proof-run-random" type="submit" :disabled="!!preparing">Run random</button>
    <label class="proof-controls__warm"><input id="proof-warm" v-model="warm" type="checkbox" :disabled="!!preparing"> warm up first (fair)</label>
    <button v-if="canClear" id="proof-clear" type="button" class="proof-controls__secondary" :disabled="!!preparing" @click="emit('clear')">Clear</button>
    <span v-if="preparing" id="proof-preparing" class="proof-controls__preparing">{{ preparing }}</span>
    <slot />
  </form>
</template>

<style scoped>
.proof-controls { display: contents; }
.proof-controls input { padding: .45rem .6rem; border: 1px solid #ccc; border-radius: 8px; }
.proof-controls__count { display: flex; align-items: center; gap: .4rem; }
.proof-controls__count input { width: 5.5rem; }
.proof-controls__count small { color: #777; }
.proof-controls__warm { display: flex; align-items: center; gap: .3rem; font-size: .9rem; }
.proof-controls button { padding: .5rem 1rem; border: 0; border-radius: 8px; background: #e3350d; color: #fff; cursor: pointer; }
.proof-controls button:disabled { opacity: .5; cursor: progress; }
.proof-controls .proof-controls__secondary { background: #8a8f98; }
.proof-controls__preparing { color: #666; }
</style>
