// Vite+ workspace config — used ONLY for `vp run` task orchestration + caching.
// (Vitest keeps its own root `vitest.config.ts`, which takes precedence over this file.)
//
//   vp run lib:all      build every library, in dependency order, cached
//   vp cache clean      drop all cached task results
//
// The root package.json scripts (`pnpm build`, …) call these tasks, so both entry points
// behave the same.
import { defineConfig } from 'vite-plus'

/**
 * A cached build of one workspace folder: runs that folder's own `build` script.
 * Excluded from the inputs:
 * - its previous `dist/`: the builders clean and rewrite it, and a task that reads what it
 *   writes can't be cached;
 * - the ROOT package.json: `pnpm run` reads it every time, so editing a root script would
 *   otherwise rebuild everything. (Each package's own package.json stays tracked.)
 * - Nuxt's generated folders (`.nuxt/`, `playground/.nuxt|.output`): `dev:prepare` and the
 *   e2e tests rewrite them, so they are not inputs of a library build.
 */
const IGNORED_INPUTS = [
  '!package.json',
  '!**/node_modules/.cache/**',
  '!**/node_modules/.vite/**',
  '!**/.nuxt/**',
  '!**/.output/**',
]

const buildIn = (dir: string, dependsOn: string[] = [], outDir = `${dir}/dist`) => ({
  command: 'pnpm run build',
  cwd: dir,
  dependsOn,
  cache: {
    input: [{ auto: true }, `!${outDir}/**`, ...IGNORED_INPUTS],
    output: [`${outDir}/**`],
  },
})

export default defineConfig({
  run: {
    tasks: {
      'lib:nuxt-pre-fetch': buildIn('packages/nuxt-pre-fetch'),
      'lib:all': {
        command: 'node -e "console.log(\'libraries built\')"',
        dependsOn: ['lib:nuxt-pre-fetch'],
        cache: false,
      },
    },
  },
})
