<script setup lang="ts">
// Declared requests: like /learned, the request is built at runtime (from the `demo_q` cookie,
// in onMounted). app/prefetch/declared.ts declares the same request, so even the FIRST visit
// gets it from the HTML — no learning.
const nuxtApp = useNuxtApp()
const token = useCookie<string | null>('demo_token')
const q = useCookie<string | null>('demo_q')

const result = ref<{ q: string, auth: string | null } | null>(null)
const source = ref('')

onMounted(async () => {
  const url: string = '/api/learned-items'
  const query = { q: q.value ?? 'a' }
  const hit = await nuxtApp.$nuxtPreFetch?.take('GET', url, query)
  source.value = hit ? 'prefetched' : 'network'
  result.value = hit
    ? hit.data as typeof result.value
    : await $fetch<{ q: string, auth: string | null }>(url, { query, headers: token.value ? { authorization: `Bearer ${token.value}` } : {} })
})
</script>

<template>
  <section>
    <h1>Declared requests</h1>
    <dl v-if="result">
      <dt>Source</dt><dd id="declared-source">{{ source }}</dd>
      <dt>q</dt><dd id="declared-q">{{ result.q }}</dd>
      <dt>Authorization</dt><dd id="declared-auth">{{ result.auth ?? 'none' }}</dd>
    </dl>
  </section>
</template>
