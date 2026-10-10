<script setup lang="ts">
// "Runs in this tab": every complete run stored for one proof page, newest first; the
// shown run is highlighted.
const props = defineProps<{ runs: ProofRun[], shownRun?: string }>()

const complete = computed(() => props.runs.filter(r => r.useFetch.data !== null && r.usePreFetch.data !== null))
const ms = (value: number | null | undefined) => value === null || value === undefined ? '–' : `${Math.round(value)} ms`
const mixLabel = (r: ProofRun) => {
  if (r.label) return r.label
  const names = r.names.map(formatPokemonName)
  return names.length > 4 ? `${names.slice(0, 4).join(', ')} +${names.length - 4} more` : names.join(', ')
}
// Older stored runs (one Pokémon = pokemon + species request) have no `requestsPerSide`.
const requestsPerSide = (r: ProofRun) => r.requestsPerSide ?? r.ids.length * 2
const faster = (r: ProofRun) => useFetchStandalone(r)! >= r.usePreFetch.data!
</script>

<template>
  <section v-if="complete.length" class="proof-runs">
    <h2>Runs in this tab</h2>
    <table id="proof-runs" class="proof-runs__table">
      <thead>
        <tr>
          <th>Data</th>
          <th>Requests / side</th>
          <th>Run</th>
          <th>Cache</th>
          <th>useFetch (standalone)</th>
          <th>usePreFetch</th>
          <th>Difference</th>
          <th>Nitro prefetch</th>
          <th>Browser requests (left / right)</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in complete" :key="r.run" :class="{ 'proof-runs__shown': r.run === shownRun }">
          <td>{{ mixLabel(r) }}</td>
          <td>{{ requestsPerSide(r) }}</td>
          <td>{{ r.kind === 'navigation' ? 'in place' : 'page load' }}</td>
          <td>{{ r.warmed ? 'warmed' : 'cold' }}</td>
          <td>{{ ms(useFetchStandalone(r)) }}</td>
          <td>{{ ms(r.usePreFetch.data) }}</td>
          <td :class="faster(r) ? 'proof-runs__win' : 'proof-runs__loss'">
            {{ faster(r) ? '−' : '+' }}{{ ms(Math.abs(useFetchStandalone(r)! - r.usePreFetch.data!)) }}
          </td>
          <td>{{ ms(r.serverPrefetch) }}</td>
          <td>{{ r.useFetch.browserRequests }} / {{ r.usePreFetch.browserRequests }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.proof-runs { margin-top: 2rem; }
.proof-runs__table { width: 100%; border-collapse: collapse; font-size: .9rem; background: #fff; }
.proof-runs__table th, .proof-runs__table td { padding: .45rem .6rem; border-bottom: 1px solid #eee; text-align: left; }
.proof-runs__table th { background: #f6f7f9; font-weight: 600; }
.proof-runs__shown { background: #fffbe6; }
.proof-runs__win { color: #18a058; font-weight: 600; }
.proof-runs__loss { color: #c0392b; font-weight: 600; }
</style>
