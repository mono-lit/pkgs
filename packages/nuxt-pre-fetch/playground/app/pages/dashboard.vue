<script setup lang="ts">
interface User {
  id: number
  name: string
}
interface Product {
  id: number
  name: string
}

const { data: users, pending, error, refresh } = await usePreFetch<User[]>('/api/users', {
  key: 'users',
  default: () => [],
})

const { data: products } = await usePreFetch<Product[]>('/api/products')

// Same explicit key as above → shares the same reactive state, one request.
const { data: sameUsers } = await usePreFetch<User[]>('/api/users', { key: 'users', default: () => [] })

const { data: time, refresh: refreshTime } = await usePreFetch<{ n: number }>('/api/time')
</script>

<template>
  <main>
    <h1>Dashboard</h1>
    <button id="refresh-users" @click="refresh()">Refresh users</button>
    <button id="refresh-time" @click="refreshTime()">Refresh time</button>
    <p v-if="pending">Loading...</p>
    <p v-else-if="error">Failed to load users</p>
    <ul v-else id="users">
      <li v-for="user in users" :key="user.id">{{ user.name }}</li>
    </ul>
    <ul id="products">
      <li v-for="product in products" :key="product.id">{{ product.name }}</li>
    </ul>
    <p id="same-users">{{ sameUsers.length }}</p>
    <p id="time">{{ time?.n }}</p>
  </main>
</template>
