<script setup lang="ts">
const route = useRoute()

// Both requests are prefetched on Nitro (initial load and client navigation). PokeAPI's
// Pokémon resource is ~300 KB (mostly `moves`); a literal `pick` without `transform`
// is applied on the server too, so only these keys are embedded in the HTML.
const { data: pokemon, error } = await usePreFetch<Pokemon>(
  () => `https://pokeapi.co/api/v2/pokemon/${route.params.id}`,
  { pick: ['id', 'name', 'height', 'weight', 'base_experience', 'types', 'stats', 'abilities'] },
)

// Alternate forms (ids above 10000) have no species of their own: a 404 here only hides that section.
const { data: species } = await usePreFetch<PokemonSpecies>(
  () => `https://pokeapi.co/api/v2/pokemon-species/${route.params.id}`,
  { pick: ['genera', 'flavor_text_entries', 'color', 'habitat', 'generation', 'is_legendary', 'is_mythical'] },
)

const label = computed(() => pokemon.value ? formatPokemonName(pokemon.value.name) : '')
const genus = computed(() => species.value?.genera.find(g => g.language.name === 'en')?.genus)
const flavor = computed(() => {
  const entries = species.value?.flavor_text_entries.filter(e => e.language.name === 'en') ?? []
  return entries.at(-1)?.flavor_text.replace(/\s+/g, ' ')
})
const types = computed(() => [...(pokemon.value?.types ?? [])].sort((a, b) => a.slot - b.slot).map(t => t.type.name))
const stats = computed(() => (pokemon.value?.stats ?? []).map(s => ({
  name: s.stat.name,
  label: POKEMON_STAT_LABELS[s.stat.name] ?? s.stat.name,
  value: s.base_stat,
  percent: Math.min(100, Math.round((s.base_stat / 255) * 100)),
})))
const statTotal = computed(() => stats.value.reduce((sum, s) => sum + s.value, 0))
const accent = computed(() => POKEMON_TYPE_COLORS[types.value[0] ?? 'unknown'])
// Back to the list page that contains this Pokémon.
const listOffset = computed(() => pokemon.value && pokemon.value.id <= 10000
  ? Math.floor((pokemon.value.id - 1) / POKEMON_PAGE_SIZE) * POKEMON_PAGE_SIZE
  : 0)

useHead(() => ({ title: label.value ? `${label.value} · Pokédex` : 'Pokédex' }))
</script>

<template>
  <main class="pokemon" :style="{ '--accent': accent }">
    <NuxtLink id="pokemon-back" class="pokemon__back" :to="{ path: '/pokemon', query: listOffset ? { offset: String(listOffset) } : {} }">‹ Pokédex</NuxtLink>

    <div v-if="error" id="pokemon-error" class="pokemon__error" role="alert">
      <h1>{{ error.statusCode === 404 ? 'Pokémon not found' : 'Could not load this Pokémon' }}</h1>
      <p>“{{ route.params.id }}” ({{ error.statusCode || 'network error' }})</p>
    </div>

    <article v-else-if="pokemon" class="pokemon__card">
      <header class="pokemon__hero">
        <img :src="pokemonArtwork(pokemon.id)" :alt="label" width="240" height="240">
        <div>
          <p class="pokemon__number">{{ formatPokemonId(pokemon.id) }}</p>
          <h1 id="pokemon-name">{{ label }}</h1>
          <p v-if="genus" id="pokemon-genus" class="pokemon__genus">{{ genus }}</p>
          <ul id="pokemon-types" class="pokemon__types">
            <li v-for="type in types" :key="type" :style="{ background: POKEMON_TYPE_COLORS[type] }">{{ type }}</li>
          </ul>
          <p v-if="species?.is_legendary || species?.is_mythical" class="pokemon__badge">
            {{ species.is_legendary ? 'Legendary' : 'Mythical' }}
          </p>
          <p v-if="flavor" id="pokemon-flavor" class="pokemon__flavor">{{ flavor }}</p>
        </div>
      </header>

      <section class="pokemon__facts">
        <div><span>Height</span><strong>{{ (pokemon.height / 10).toFixed(1) }} m</strong></div>
        <div><span>Weight</span><strong>{{ (pokemon.weight / 10).toFixed(1) }} kg</strong></div>
        <div v-if="pokemon.base_experience"><span>Base exp.</span><strong>{{ pokemon.base_experience }}</strong></div>
        <div v-if="species?.habitat"><span>Habitat</span><strong>{{ formatPokemonName(species.habitat.name) }}</strong></div>
        <div v-if="species?.generation"><span>Generation</span><strong>{{ species.generation.name.replace('generation-', '').toUpperCase() }}</strong></div>
      </section>

      <section>
        <h2>Abilities</h2>
        <ul class="pokemon__abilities">
          <li v-for="ability in pokemon.abilities" :key="ability.ability.name">
            {{ formatPokemonName(ability.ability.name) }}<small v-if="ability.is_hidden"> (hidden)</small>
          </li>
        </ul>
      </section>

      <section>
        <h2>Base stats <small>total {{ statTotal }}</small></h2>
        <dl id="pokemon-stats" class="pokemon__stats">
          <template v-for="stat in stats" :key="stat.name">
            <dt>{{ stat.label }}</dt>
            <dd>
              <span class="pokemon__stat-value">{{ stat.value }}</span>
              <span class="pokemon__bar"><span :style="{ width: `${stat.percent}%` }" /></span>
            </dd>
          </template>
        </dl>
      </section>

      <nav class="pokemon__nav" aria-label="Neighbouring Pokémon">
        <NuxtLink v-if="pokemon.id > 1" id="pokemon-prev" :to="`/pokemon/${pokemon.id - 1}`">‹ {{ formatPokemonId(pokemon.id - 1) }}</NuxtLink>
        <span v-else />
        <NuxtLink id="pokemon-next" :to="`/pokemon/${pokemon.id + 1}`">{{ formatPokemonId(pokemon.id + 1) }} ›</NuxtLink>
      </nav>
    </article>
  </main>
</template>

<style scoped>
.pokemon { --accent: #68a090; max-width: 860px; margin: 0 auto; padding: 1.5rem 1rem 3rem; font-family: system-ui, sans-serif; }
.pokemon__back { display: inline-block; margin-bottom: 1rem; color: inherit; }
.pokemon__card { border-radius: 16px; overflow: hidden; background: #fff; box-shadow: 0 8px 24px rgb(0 0 0 / .08); padding-bottom: 1.5rem; }
.pokemon__card > section, .pokemon__nav { padding: 0 1.5rem; }
.pokemon__hero { display: flex; flex-wrap: wrap; gap: 1.5rem; align-items: center; padding: 1.5rem; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 35%, white), white); }
.pokemon__hero img { width: 240px; height: 240px; object-fit: contain; }
.pokemon__hero h1 { margin: 0; font-size: 2.2rem; }
.pokemon__number { margin: 0; color: #666; font-weight: 600; }
.pokemon__genus { margin: .25rem 0 .5rem; color: #555; }
.pokemon__types { list-style: none; display: flex; gap: .5rem; padding: 0; margin: .5rem 0; }
.pokemon__types li { padding: .2rem .75rem; border-radius: 999px; color: #fff; text-transform: capitalize; font-size: .85rem; text-shadow: 0 1px 1px rgb(0 0 0 / .3); }
.pokemon__badge { display: inline-block; margin: 0; padding: .15rem .6rem; border-radius: 6px; background: #ffd75e; font-weight: 600; font-size: .8rem; }
.pokemon__flavor { max-width: 32rem; line-height: 1.5; }
.pokemon__facts { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1.5rem 0 .5rem; }
.pokemon__facts div { display: flex; flex-direction: column; padding: .75rem 1rem; border-radius: 10px; background: #f4f5f7; min-width: 7rem; }
.pokemon__facts span { font-size: .8rem; color: #777; }
.pokemon__abilities { display: flex; flex-wrap: wrap; gap: .5rem; list-style: none; padding: 0; }
.pokemon__abilities li { padding: .3rem .75rem; border-radius: 8px; background: #f4f5f7; }
.pokemon__stats { display: grid; grid-template-columns: 6rem 1fr; gap: .5rem 1rem; align-items: center; }
.pokemon__stats dt { color: #555; }
.pokemon__stats dd { margin: 0; display: flex; gap: .75rem; align-items: center; }
.pokemon__stat-value { width: 2.5rem; text-align: right; font-weight: 600; }
.pokemon__bar { flex: 1; height: 8px; border-radius: 4px; background: #eee; overflow: hidden; }
.pokemon__bar span { display: block; height: 100%; background: var(--accent); }
.pokemon__nav { display: flex; justify-content: space-between; margin-top: 1.5rem; }
.pokemon__error { padding: 1.5rem; border-radius: 12px; background: #fdecea; }
</style>
