<script setup lang="ts">
const route = useRoute()

// Request identity includes the query: ?status=active and ?status=inactive are
// different requests. `computed` keeps the query reactive across navigations
// that reuse this page (exactly as with useFetch).
const { data } = await usePreFetch<{ status: string }>('/api/filtered', {
  query: { status: computed(() => route.query.status) },
})
</script>

<template>
  <main>
    <h1>Search</h1>
    <p id="status">{{ data?.status }}</p>
  </main>
</template>
