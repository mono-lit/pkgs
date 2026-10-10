<script setup lang="ts">
// The data of one proof side, grouped by PokeAPI resource (Pokémon, moves, abilities, items).
// Items come from a page (AsyncData refs) or a Pinia store (refs already unwrapped):
// `toValue` reads both.
const props = defineProps<{
  items: ProofItem[]
  /** The page was opened by a run (otherwise one is being started). */
  testing: boolean
}>()

const active = computed(() => props.items.filter(item => item.id))
const groups = computed(() => PROOF_RESOURCES
  .map(resource => ({ ...resource, items: active.value.filter(item => item.kind === resource.kind) }))
  .filter(group => group.items.length))

type Data = Record<string, any> | null | undefined
const read = (item: ProofItem) => toValue(item.request.data) as Data
const failed = (item: ProofItem) => toValue(item.request.error) as { statusCode?: number } | null | undefined
const pretty = (name: string) => name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')

/** One short fact per resource (from the picked keys). */
function detail(item: ProofItem): string {
  const data = read(item)
  if (!data) return ''
  switch (item.kind) {
    case 'pokemon': return (data.types ?? []).map((type: { type: { name: string } }) => type.type.name).join(' / ')
    case 'move': return [data.type?.name, data.power ? `${data.power} power` : 'status'].filter(Boolean).join(' · ')
    case 'ability': return data.generation?.name?.replace('generation-', 'gen ').toUpperCase() ?? ''
    case 'item': return [data.category?.name ? pretty(data.category.name) : '', data.cost ? `₽${data.cost}` : ''].filter(Boolean).join(' · ')
  }
  return ''
}
</script>

<template>
  <p v-if="!active.length" class="proof-mix__placeholder">{{ testing ? 'loading…' : 'starting a run…' }}</p>
  <div v-else class="proof-mix">
    <section v-for="group in groups" :key="group.kind" :class="['proof-mix__group', `proof-mix__group--${group.kind}`]">
      <h3>{{ group.label }} <small>{{ group.items.filter(item => read(item)).length }}/{{ group.items.length }}</small></h3>
      <ul>
        <li v-for="item in group.items" :key="item.id" :data-kind="item.kind">
          <template v-if="read(item)">
            <b>{{ pretty(read(item)!.name ?? item.id) }}</b>
            <small>{{ detail(item) }}</small>
          </template>
          <small v-else-if="failed(item)" class="proof-mix__error">#{{ item.id }}: {{ failed(item)!.statusCode || 'error' }}</small>
          <small v-else class="proof-mix__loading">…</small>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.proof-mix__placeholder { display: grid; place-items: center; min-height: 220px; margin: 0; color: #999; }
.proof-mix { display: flex; flex-direction: column; gap: .6rem; padding: .6rem; }
.proof-mix__group h3 { margin: 0 0 .3rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: #555; }
.proof-mix__group h3 small { font-weight: 400; color: #999; }
.proof-mix__group ul { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: .3rem; padding: 0; margin: 0; }
.proof-mix__group li { display: flex; flex-direction: column; min-height: 2.4rem; padding: .25rem .4rem; border-radius: 6px; background: #f6f7f9; border-left: 3px solid #ccc; font-size: .78rem; }
.proof-mix__group--pokemon li { border-left-color: #e3350d; }
.proof-mix__group--move li { border-left-color: #6390f0; }
.proof-mix__group--ability li { border-left-color: #a33ea1; }
.proof-mix__group--item li { border-left-color: #e2bf65; }
.proof-mix__group li small { color: #777; font-size: .68rem; text-transform: capitalize; }
.proof-mix__loading { margin: auto; color: #999; }
.proof-mix__error { color: #b00020 !important; }
</style>
