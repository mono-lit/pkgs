<script setup lang="ts">
// "How to read it": identical on every proof page. The default slot adds a page-specific
// paragraph (e.g. how the Pinia page differs) after the shared ones.
</script>

<template>
  <section class="proof-notes">
    <h2>How to read it</h2>
    <slot />
    <p>
      <b>Two kinds of runs</b> (the "Run" column). <i>In place</i>: arriving on the page starts a run without reloading.
      The new mix (<code>?pokemon=…&amp;move=…&amp;ability=…&amp;item=…</code>) is pushed onto the route, the left half fetches from the browser and the right half comes through
      Nitro's prefetch endpoint, exactly what <code>usePreFetch</code> does on client navigation. Times count from the route change.
      <i>Page load</i>: <b>Run random</b> (or a browser reload of a run) is a full page load and the right half's data is
      embedded in the HTML. Times count from navigation start.
    </p>
    <p>
      Both halves live in the same page, so they share one HTML response, and that response waited for Nitro's
      prefetch (the <code>Server-Timing: nuxt-pre-fetch</code> header). A real <code>useFetch</code> page would not
      wait for it, so the left half is shown as <b>standalone</b>: measured time minus the server prefetch time.
      The raw measurement is listed as "On this shared page".
    </p>
    <p>
      <b>Warm-up (default):</b> right before the reload the server fetches every URL of the run once
      (<code>POST /api/proof-warm</code>, in parallel). That warms PokeAPI's CDN cache for <i>both</i> sides and keeps
      Nitro's connections to PokeAPI open, like a server that has traffic. Without it Nitro, which asks PokeAPI first,
      pays for every resource PokeAPI's CDN hasn't cached yet plus a fresh TLS handshake, while the left half's browser
      requests a moment later hit the cache Nitro just warmed over the browser's already-open HTTP/2 connection. Untick
      it to see that cold case (the table shows which runs were warmed).
    </p>
    <p>
      <b>The mix:</b> a run of N requests is split evenly over four PokeAPI resources, each with random ids:
      <code>/pokemon/{id}</code> (types), <code>/move/{id}</code> (type, power), <code>/ability/{id}</code> (generation)
      and <code>/item/{id}</code> (category, cost). 100 requests = 25 of each. Every request is a different URL, so
      nothing is answered twice, and each side trims its responses to a few keys with <code>pick</code> (the right
      half on the server, before the data goes into the HTML).
    </p>
    <p>
      Both sides send all their requests concurrently: the left half's <code>useFetch</code> calls start together in
      the browser once Vue has booted; Nitro runs the right half's in parallel (<code>concurrency: 16</code> in this
      playground) before the HTML is sent. A run is capped at 500 requests per side (125 per resource) to go easy on
      PokeAPI: the pages read only the first 125 ids of each list (<code>.slice(0, 125)</code>, also understood at build
      time), so editing the URL can't raise it. The library default caps lists at 20 (<code>maxListItems</code>).
    </p>
    <p>
      JS stays in the browser cache between runs, so these are warm "returning visitor" loads; data requests use
      <code>cache: 'no-store'</code>. Measure on the <b>production build</b>, because under <code>nuxi dev</code> Vite's
      unbundled modules dominate. To simulate a mobile user, open DevTools → Network → <b>Slow 4G</b> and run.
    </p>
  </section>
</template>

<style scoped>
.proof-notes { margin-top: 2rem; }
.proof-notes p { font-size: .85rem; color: #555; line-height: 1.5; }
</style>
