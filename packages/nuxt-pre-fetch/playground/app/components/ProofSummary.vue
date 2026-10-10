<script setup lang="ts">
// "usePreFetch showed the data X ms sooner" bar over all complete runs (medians).
const props = defineProps<{ runs: ProofRun[] }>()

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const summary = computed(() => {
  const complete = props.runs.filter(r => r.useFetch.data !== null && r.usePreFetch.data !== null)
  if (!complete.length) return null
  const left = median(complete.map(r => useFetchStandalone(r)!))
  const right = median(complete.map(r => r.usePreFetch.data!))
  const wins = complete.filter(r => r.usePreFetch.data! < useFetchStandalone(r)!).length
  return { left, right, saved: left - right, percent: left ? ((left - right) / left) * 100 : 0, count: complete.length, wins }
})
const ms = (value: number) => `${Math.round(value)} ms`
</script>

<template>
  <section v-if="summary" id="proof-summary" class="proof-summary" :class="{ 'proof-summary--slower': summary.saved < 0 }">
    <template v-if="summary.saved >= 0">
      <b>usePreFetch</b> showed the data <b>{{ Math.round(summary.saved) }} ms sooner</b> ({{ summary.percent.toFixed(0) }}% faster)
    </template>
    <template v-else>
      <b>useFetch</b> was {{ Math.round(-summary.saved) }} ms sooner
    </template>
    <span>median of {{ summary.count }} run{{ summary.count > 1 ? 's' : '' }}: {{ ms(summary.left) }} → {{ ms(summary.right) }} · usePreFetch faster in {{ summary.wins }}/{{ summary.count }}</span>
  </section>
</template>

<style scoped>
.proof-summary { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; align-items: baseline; margin: 1.25rem 0 0; padding: .9rem 1.1rem; border-radius: 12px; background: #e8f6ee; font-size: 1.1rem; }
.proof-summary--slower { background: #fff4e5; }
.proof-summary span { color: #555; font-size: .9rem; }
</style>
