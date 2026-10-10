import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  test: {
    projects: [
      {
        // Pure logic: analyzer, route matcher, identity, serializer, runner, client store.
        resolve: {
          alias: {
            '#imports': r('./test/unit/stubs/imports.ts'),
            'nitropack/runtime': r('./test/unit/stubs/imports.ts'),
            '#nuxt-pre-fetch/manifest': r('./test/unit/stubs/manifest.ts'),
            '#nuxt-pre-fetch/definitions': r('./test/unit/stubs/definitions.ts'),
          },
        },
        test: {
          name: 'unit',
          root: r('.'),
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Production build of the playground (against dist/) + Playwright Chromium.
        test: {
          name: 'e2e',
          root: r('.'),
          include: ['test/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
})
