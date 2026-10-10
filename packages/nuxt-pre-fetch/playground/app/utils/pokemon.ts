// Shared PokeAPI types and helpers for the Pokémon pages (auto-imported).

export interface NamedResource {
  name: string
  url: string
}

export interface PokemonList {
  count: number
  next: string | null
  previous: string | null
  results: NamedResource[]
}

export interface Pokemon {
  id: number
  name: string
  height: number
  weight: number
  base_experience: number | null
  types: Array<{ slot: number, type: NamedResource }>
  stats: Array<{ base_stat: number, effort: number, stat: NamedResource }>
  abilities: Array<{ ability: NamedResource, is_hidden: boolean, slot: number }>
}

export interface PokemonSpecies {
  genera: Array<{ genus: string, language: NamedResource }>
  flavor_text_entries: Array<{ flavor_text: string, language: NamedResource, version: NamedResource }>
  color: NamedResource
  habitat: NamedResource | null
  generation: NamedResource
  is_legendary: boolean
  is_mythical: boolean
}

export const POKEMON_PAGE_SIZE = 24

/** `https://pokeapi.co/api/v2/pokemon/25/` → 25 */
export function pokemonIdFromUrl(url: string): number {
  return Number(url.split('/').filter(Boolean).pop())
}

export function pokemonArtwork(id: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`
}

export function formatPokemonName(name: string): string {
  return name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

export function formatPokemonId(id: number): string {
  return `#${String(id).padStart(4, '0')}`
}

export const POKEMON_TYPE_COLORS: Record<string, string> = {
  normal: '#a8a77a', fire: '#ee8130', water: '#6390f0', electric: '#f7d02c', grass: '#7ac74c',
  ice: '#96d9d6', fighting: '#c22e28', poison: '#a33ea1', ground: '#e2bf65', flying: '#a98ff3',
  psychic: '#f95587', bug: '#a6b91a', rock: '#b6a136', ghost: '#735797', dragon: '#6f35fc',
  dark: '#705746', steel: '#b7b7ce', fairy: '#d685ad', stellar: '#40b5a5', unknown: '#68a090',
}

export const POKEMON_STAT_LABELS: Record<string, string> = {
  'hp': 'HP',
  'attack': 'Attack',
  'defense': 'Defense',
  'special-attack': 'Sp. Atk',
  'special-defense': 'Sp. Def',
  'speed': 'Speed',
}
