<script setup lang="ts">
// One side of a proof page: LEFT = useFetch, RIGHT = usePreFetch. The default slot is the
// rendered data; below it the measured metrics and a timeline of the shown run.
const props = defineProps<{
  mode: ProofMode
  subtitle: string
  run: ProofRun | null
}>()

const ms = (value: number | null | undefined) => value === null || value === undefined ? '–' : `${Math.round(value)} ms`
const kb = (bytes: number) => bytes ? `${(bytes / 1024).toFixed(1)} KB` : '–'

/** Timeline of this side, scaled against the slower side of the run. */
const timeline = computed(() => {
  const r = props.run
  if (!r) return []
  const scale = Math.max(useFetchStandalone(r) ?? 0, r.usePreFetch.data ?? 0, r.useFetch.data ?? 0, 1)
  const end = r[props.mode].data ?? r.html
  const out: Array<{ label: string, from: number, to: number, kind: string }> = []
  const inPlace = r.kind === 'navigation'
  if (props.mode === 'usePreFetch') {
    out.push({ label: inPlace ? 'route change (Nitro prefetch stream started)' : 'HTML (Nitro fetching the data)', from: 0, to: r.html, kind: 'html' })
    out.push({ label: inPlace ? 'results streaming in + render' : 'JS + Vue boot + render', from: r.html, to: end, kind: 'boot' })
  }
  else {
    const own = r.requests.filter(q => q.start >= r.html)
    const first = own.length ? Math.min(...own.map(q => q.start)) : end
    const last = own.length ? Math.max(...own.map(q => q.end)) : end
    out.push({ label: 'HTML (incl. the right side\'s prefetch)', from: 0, to: r.html, kind: 'html' })
    out.push({ label: 'JS + Vue boot', from: r.html, to: first, kind: 'boot' })
    out.push({ label: `browser → API (${own.length} requests)`, from: first, to: last, kind: 'api' })
    out.push({ label: 'render', from: last, to: end, kind: 'render' })
  }
  return out
    .filter(m => m.to > m.from)
    .map(m => ({ ...m, left: `${(m.from / scale) * 100}%`, width: `${Math.max(0.5, ((m.to - m.from) / scale) * 100)}%`, duration: m.to - m.from }))
})
</script>

<template>
  <section :class="['proof-side', `proof-side--${mode}`]">
    <h2>
      <span class="proof-side__tag">{{ mode === 'useFetch' ? 'LEFT' : 'RIGHT' }}</span><code>{{ mode }}</code>
      <small>{{ subtitle }}</small>
    </h2>

    <div class="proof-side__card">
      <slot />
    </div>

    <template v-if="run">
      <dl :id="`proof-metrics-${mode}`" class="proof-side__metrics">
        <div class="proof-side__metric proof-side__metric--main">
          <dt>All data on screen</dt>
          <dd>{{ ms(mode === 'useFetch' ? useFetchStandalone(run) : run.usePreFetch.data) }}</dd>
        </div>
        <div class="proof-side__metric">
          <dt>{{ mode === 'useFetch' ? 'On this shared page' : run.kind === 'navigation' ? 'Nitro prefetch (endpoint)' : 'Nitro prefetch (in HTML)' }}</dt>
          <dd>{{ mode === 'useFetch' ? ms(run.useFetch.data) : ms(run.serverPrefetch) }}</dd>
        </div>
        <div class="proof-side__metric"><dt>Browser data requests</dt><dd>{{ run[mode].browserRequests }}</dd></div>
        <div class="proof-side__metric"><dt>{{ run.kind === 'navigation' ? 'Prefetch payload' : 'Embedded payload' }}</dt><dd>{{ mode === 'usePreFetch' ? kb(run.payloadBytes) : '–' }}</dd></div>
      </dl>

      <div class="proof-side__track">
        <span
          v-for="mark in timeline"
          :key="mark.kind"
          :class="['proof-side__bar', `proof-side__bar--${mark.kind}`]"
          :style="{ left: mark.left, width: mark.width }"
          :title="`${mark.label}: ${Math.round(mark.duration)} ms`"
        />
      </div>
      <ul class="proof-side__legend">
        <li v-for="mark in timeline" :key="mark.kind">
          <i :class="['proof-side__bar', `proof-side__bar--${mark.kind}`]" />{{ mark.label }} <b>{{ Math.round(mark.duration) }} ms</b>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.proof-side { padding: 1rem; border-radius: 14px; background: #f6f7f9; border-top: 4px solid #8a8f98; min-width: 0; }
.proof-side--usePreFetch { border-top-color: #18a058; }
.proof-side h2 { display: flex; flex-wrap: wrap; align-items: baseline; gap: .25rem .6rem; margin: 0 0 .75rem; font-size: 1.2rem; }
.proof-side h2 small { flex-basis: 100%; font-size: .8rem; font-weight: 400; color: #666; }
.proof-side__tag { padding: .05rem .45rem; border-radius: 6px; background: #8a8f98; color: #fff; font-size: .7rem; font-weight: 700; }
.proof-side--usePreFetch .proof-side__tag { background: #18a058; }
.proof-side__card { min-height: 220px; max-height: 420px; overflow: auto; border-radius: 10px; background: #fff; border: 1px solid #e3e3e3; }
.proof-side__metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: .5rem; margin: .75rem 0; }
.proof-side__metric { padding: .5rem .6rem; border-radius: 8px; background: #fff; }
.proof-side__metric dt { font-size: .72rem; color: #777; }
.proof-side__metric dd { margin: 0; font-weight: 600; }
.proof-side__metric--main dd { font-size: 1.35rem; }
.proof-side--usePreFetch .proof-side__metric--main dd { color: #18a058; }
.proof-side__track { position: relative; height: 18px; border-radius: 4px; background: #e9eaee; overflow: hidden; }
.proof-side__track .proof-side__bar { position: absolute; top: 0; bottom: 0; }
.proof-side__bar { display: inline-block; }
.proof-side__bar--html { background: #6c8ebf; }
.proof-side__bar--boot { background: #b7a6e0; }
.proof-side__bar--api { background: #e3350d; }
.proof-side__bar--render { background: #f2b544; }
.proof-side__legend { list-style: none; display: flex; flex-wrap: wrap; gap: .25rem .9rem; padding: 0; margin: .5rem 0 0; font-size: .8rem; color: #444; }
.proof-side__legend i { width: 10px; height: 10px; margin-right: .3rem; border-radius: 2px; vertical-align: -1px; }
</style>
