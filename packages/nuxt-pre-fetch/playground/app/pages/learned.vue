<script setup lang="ts">
// Learned requests: this page's request is built at RUNTIME, in onMounted, like a data layer
// whose URLs come from runtime state — the build can't see it. The page reports it
// (`$nuxtPreFetch.learn`); from the next visit on, Nitro replays it while producing the HTML
// and the page takes the result instead of fetching (`$nuxtPreFetch.take`).
const route = useRoute()
const nuxtApp = useNuxtApp()
const token = useCookie<string | null>('demo_token')

const q = computed(() => String(route.query.q ?? 'a'))
const result = ref<{ q: string, auth: string | null } | null>(null)
const source = ref('')

async function load() {
  const url: string = '/api/learned-items'
  const query = { q: q.value }
  const prefetch = nuxtApp.$nuxtPreFetch
  // Report it either way: the stored set is what the last visit used. The token is never
  // reported, only the cookie that holds it.
  prefetch?.learn({ url, query, auth: token.value ? { cookie: 'demo_token' } : undefined })
  const hit = await prefetch?.take('GET', url, query)
  source.value = hit ? 'learned' : 'network'
  result.value = hit
    ? hit.data as typeof result.value
    : await $fetch<{ q: string, auth: string | null }>(url, { query, headers: token.value ? { authorization: `Bearer ${token.value}` } : {} })
}

onMounted(load)
watch(q, load)
</script>

<template>
  <section>
    <h1>Learned requests</h1>
    <p>
      <NuxtLink id="learned-a" to="/learned?q=a">q=a</NuxtLink> |
      <NuxtLink id="learned-b" to="/learned?q=b">q=b</NuxtLink>
    </p>
    <dl v-if="result">
      <dt>Source</dt><dd id="learned-source">{{ source }}</dd>
      <dt>q</dt><dd id="learned-q">{{ result.q }}</dd>
      <dt>Authorization</dt><dd id="learned-auth">{{ result.auth ?? 'none' }}</dd>
    </dl>
  </section>
</template>
