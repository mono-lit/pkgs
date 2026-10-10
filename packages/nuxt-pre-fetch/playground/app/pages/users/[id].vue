<script setup lang="ts">
const route = useRoute()

const { data: user, error } = await usePreFetch<{ id: number, name: string }>(
  () => `/api/users/${route.params.id}`,
)
</script>

<template>
  <main>
    <h1>User</h1>
    <p v-if="error" id="user-error">{{ error.statusCode }}</p>
    <p v-else id="user-name">{{ user?.name }}</p>
  </main>
</template>
