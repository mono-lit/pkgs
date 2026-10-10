<template>
  <div>
    <nav>
      <NuxtLink to="/">Home</NuxtLink> |
      <NuxtLink id="nav-dashboard" to="/dashboard">Dashboard</NuxtLink> |
      <NuxtLink id="nav-user-1" to="/users/1">User 1</NuxtLink> |
      <NuxtLink id="nav-user-2" to="/users/2">User 2</NuxtLink> |
      <NuxtLink id="nav-edge" to="/edge-cases">Edge cases</NuxtLink> |
      <NuxtLink id="nav-search-active" to="/search?status=active">Active</NuxtLink> |
      <NuxtLink id="nav-search-inactive" to="/search?status=inactive">Inactive</NuxtLink> |
      <NuxtLink id="nav-me" to="/me">Me</NuxtLink> |
      <NuxtLink id="nav-learned" to="/learned">Learned</NuxtLink> |
      <NuxtLink id="nav-declared" to="/declared">Declared</NuxtLink> |
      <NuxtLink id="nav-pokemon" to="/pokemon">Pokémon</NuxtLink> |
      <NuxtLink id="nav-proof" to="/performance-proof">Performance proof</NuxtLink> |
      <NuxtLink id="nav-pinia" to="/pinia">Pinia</NuxtLink>
    </nav>
    <slot />
  </div>
</template>
