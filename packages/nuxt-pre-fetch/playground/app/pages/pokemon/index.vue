<script setup lang="ts">
const route = useRoute()

// Prefetched on Nitro from PokeAPI (an allowed external host). `limit` is a literal and
// `offset` comes from the URL, so `/pokemon?offset=48` is analysed statically and each
// page is its own request. `computed` keeps it reactive when only the query changes.
const { data, error, status, refresh } = await usePreFetch<PokemonList>('https://pokeapi.co/api/v2/pokemon', {
  query: { limit: 24, offset: computed(() => route.query.offset) },
})

const offset = computed(() => Math.max(0, Number(route.query.offset) || 0))
const total = computed(() => data.value?.count ?? 0)
const page = computed(() => Math.floor(offset.value / POKEMON_PAGE_SIZE) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / POKEMON_PAGE_SIZE)))
const lastOffset = computed(() => (pageCount.value - 1) * POKEMON_PAGE_SIZE)

const pokemon = computed(() => (data.value?.results ?? []).map((entry) => {
  const id = pokemonIdFromUrl(entry.url)
  return { id, name: entry.name, label: formatPokemonName(entry.name), number: formatPokemonId(id), image: pokemonArtwork(id) }
}))

const pageLink = (value: number) => ({ path: '/pokemon', query: value > 0 ? { offset: String(value) } : {} })

const search = ref('')
async function goTo() {
  const target = search.value.trim().toLowerCase().replace(/^#0*/, '').replace(/\s+/g, '-')
  if (target) await navigateTo(`/pokemon/${encodeURIComponent(target)}`)
}

useHead(() => ({ title: `Pokédex · page ${page.value}` }))
</script>

<template>
  <main class="pokedex">
    <header class="pokedex__header">
      <div>
        <h1>Pokédex</h1>
        <p v-if="total" id="pokemon-meta" class="pokedex__meta">{{ total }} Pokémon · page {{ page }} of {{ pageCount }}</p>
      </div>
      <form class="pokedex__search" @submit.prevent="goTo">
        <input id="pokemon-search" v-model="search" type="search" placeholder="Name or number, e.g. pikachu or 25" aria-label="Go to Pokémon">
        <button type="submit">Go</button>
      </form>
    </header>

    <div v-if="error" class="pokedex__error" role="alert">
      <p>Could not load the Pokédex ({{ error.statusCode || 'network error' }}).</p>
      <button type="button" @click="refresh()">Try again</button>
    </div>

    <template v-else>
      <ul id="pokemon-list" class="pokedex__grid" :aria-busy="status === 'pending'">
        <li v-for="entry in pokemon" :key="entry.id">
          <NuxtLink :to="`/pokemon/${entry.id}`" class="pokedex__card">
            <img :src="entry.image" :alt="entry.label" width="120" height="120" loading="lazy">
            <span class="pokedex__number">{{ entry.number }}</span>
            <span class="pokedex__name">{{ entry.label }}</span>
          </NuxtLink>
        </li>
      </ul>

      <nav class="pokedex__pager" aria-label="Pages">
        <NuxtLink v-if="page > 1" id="pokemon-first" :to="pageLink(0)">« First</NuxtLink>
        <NuxtLink v-if="page > 1" id="pokemon-prev" :to="pageLink(offset - POKEMON_PAGE_SIZE)">‹ Previous</NuxtLink>
        <span>{{ page }} / {{ pageCount }}</span>
        <NuxtLink v-if="page < pageCount" id="pokemon-next" :to="pageLink(offset + POKEMON_PAGE_SIZE)">Next ›</NuxtLink>
        <NuxtLink v-if="page < pageCount" id="pokemon-last" :to="pageLink(lastOffset)">Last »</NuxtLink>
      </nav>
    </template>
  </main>
</template>

<style scoped>
.pokedex { max-width: 1100px; margin: 0 auto; padding: 1.5rem 1rem 3rem; font-family: system-ui, sans-serif; }
.pokedex__header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; justify-content: space-between; margin-bottom: 1.25rem; }
.pokedex__header h1 { margin: 0; }
.pokedex__meta { margin: .25rem 0 0; color: #666; }
.pokedex__search { display: flex; gap: .5rem; }
.pokedex__search input { padding: .5rem .75rem; min-width: 16rem; border: 1px solid #ccc; border-radius: 8px; }
.pokedex__search button, .pokedex__error button { padding: .5rem 1rem; border: 0; border-radius: 8px; background: #e3350d; color: #fff; cursor: pointer; }
.pokedex__grid { list-style: none; padding: 0; margin: 0; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.pokedex__grid[aria-busy='true'] { opacity: .5; }
.pokedex__card { display: flex; flex-direction: column; align-items: center; padding: 1rem .5rem; border-radius: 12px; background: #f4f5f7; color: inherit; text-decoration: none; transition: transform .15s, box-shadow .15s; }
.pokedex__card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgb(0 0 0 / .1); }
.pokedex__card img { width: 120px; height: 120px; object-fit: contain; }
.pokedex__number { font-size: .8rem; color: #888; }
.pokedex__name { font-weight: 600; }
.pokedex__pager { display: flex; gap: 1rem; justify-content: center; align-items: center; margin-top: 2rem; }
.pokedex__error { padding: 1rem; border-radius: 8px; background: #fdecea; }
</style>
