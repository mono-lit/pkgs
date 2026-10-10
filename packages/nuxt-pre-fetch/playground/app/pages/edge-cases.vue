<script setup lang="ts">
const { data: nullValue } = await usePreFetch<null>('/api/null', { default: () => 'DEFAULT' as unknown as null })
const { data: noContent } = await usePreFetch('/api/no-content')
const { data: emptyValue } = await usePreFetch<unknown[]>('/api/empty')
const { data: falseValue } = await usePreFetch<boolean>('/api/false')
const { data: zeroValue } = await usePreFetch<number>('/api/zero')
const { data: xss } = await usePreFetch<{ html: string, line: string }>('/api/xss')
const { error: forbidden } = await usePreFetch('/api/forbidden')

// Not statically analysable (URL from a variable): documented fallback, the
// browser fetches it itself and the build prints a warning.
const endpoint = ['/api', 'products'].join('/')
const { data: dynamic } = await usePreFetch<{ id: number, name: string }[]>(endpoint)
</script>

<template>
  <main>
    <h1>Edge cases</h1>
    <p id="null">{{ JSON.stringify(nullValue) }}</p>
    <p id="no-content">{{ noContent === undefined ? 'undefined' : JSON.stringify(noContent) }}</p>
    <p id="empty">{{ JSON.stringify(emptyValue) }}</p>
    <p id="false">{{ JSON.stringify(falseValue) }}</p>
    <p id="zero">{{ JSON.stringify(zeroValue) }}</p>
    <p id="xss">{{ xss?.html }}</p>
    <p id="forbidden">{{ forbidden?.statusCode }}</p>
    <p id="dynamic">{{ dynamic?.length }}</p>
  </main>
</template>
