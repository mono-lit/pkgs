<script setup lang="ts">
// "Recorded benchmark": identical on every proof page.
// Playwright, production build, cold cache, median of 5 (method in the package README, "Performance").
const RECORDED = [
  { network: 'no throttling (localhost)', scenario: '/dashboard: local API ×3', useFetch: 141, usePreFetch: 135 },
  { network: 'no throttling (localhost)', scenario: '/pokemon list: PokeAPI ×1', useFetch: 256, usePreFetch: 228 },
  { network: 'no throttling (localhost)', scenario: '/pokemon/25: PokeAPI ×2', useFetch: 281, usePreFetch: 250 },
  { network: 'no throttling (localhost)', scenario: 'click list → detail', useFetch: 178, usePreFetch: 155 },
  { network: 'slow 4G (150 ms RTT, 4 Mbps)', scenario: '/dashboard: local API ×3', useFetch: 1689, usePreFetch: 1128 },
  { network: 'slow 4G (150 ms RTT, 4 Mbps)', scenario: '/pokemon list: PokeAPI ×1', useFetch: 1876, usePreFetch: 1296 },
  { network: 'slow 4G (150 ms RTT, 4 Mbps)', scenario: '/pokemon/25: PokeAPI ×2', useFetch: 1867, usePreFetch: 1293 },
  { network: 'slow 4G (150 ms RTT, 4 Mbps)', scenario: 'click list → detail', useFetch: 851, usePreFetch: 369 },
]
</script>

<template>
  <section class="proof-benchmark">
    <h2>Recorded benchmark</h2>
    <p>Separate pages per side, Playwright Chromium against the production build, cold cache, median of 5 runs per cell.</p>
    <table class="proof-benchmark__table">
      <thead><tr><th>Network</th><th>Scenario</th><th>useFetch</th><th>usePreFetch</th><th>Faster by</th></tr></thead>
      <tbody>
        <tr v-for="row in RECORDED" :key="row.network + row.scenario">
          <td>{{ row.network }}</td>
          <td>{{ row.scenario }}</td>
          <td>{{ row.useFetch }} ms</td>
          <td>{{ row.usePreFetch }} ms</td>
          <td class="proof-benchmark__win">{{ row.useFetch - row.usePreFetch }} ms ({{ Math.round((1 - row.usePreFetch / row.useFetch) * 100) }}%)</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.proof-benchmark { margin-top: 2rem; }
.proof-benchmark p { font-size: .85rem; color: #555; line-height: 1.5; }
.proof-benchmark__table { width: 100%; border-collapse: collapse; font-size: .9rem; background: #fff; }
.proof-benchmark__table th, .proof-benchmark__table td { padding: .45rem .6rem; border-bottom: 1px solid #eee; text-align: left; }
.proof-benchmark__table th { background: #f6f7f9; font-weight: 600; }
.proof-benchmark__win { color: #18a058; font-weight: 600; }
</style>
