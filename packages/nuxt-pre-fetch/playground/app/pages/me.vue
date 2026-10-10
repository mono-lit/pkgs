<script setup lang="ts">
const { data, error } = await usePreFetch<{ user: string }>('/api/me')
</script>

<template>
  <main>
    <h1>Me</h1>
    <p v-if="error" id="me-error">{{ error.statusCode }}</p>
    <p v-else id="me">{{ data?.user }}</p>
  </main>
</template>
