// Root Vitest config. It exists so Vitest does NOT pick up the root `vite.config.ts`,
// which belongs to Vite+ (`vp run` tasks). Vitest 4 has no `vitest.workspace.ts` and
// does not expand nested `projects`, so each package's projects (absolute `root`s)
// are pulled in here: `npx vitest run --project unit` works from the repo root.
import { defineConfig } from 'vitest/config'
import nuxtPreFetch from './packages/nuxt-pre-fetch/vitest.config'

export default defineConfig({
  test: {
    projects: [...(nuxtPreFetch.test?.projects ?? [])],
  },
})
