import { defineConfig } from 'tsdown'

export default defineConfig([
  // The module itself (build-time, Node): one bundled file + its declarations.
  {
    entry: { module: 'src/module.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outDir: 'dist',
    fixedExtension: true, // module.mjs / module.d.mts
    clean: ['dist/module.*'],
    tsconfig: 'tsconfig.build.json',
    dts: true,
    deps: {
      neverBundle: ['@nuxt/kit', '@nuxt/schema', 'nuxt', 'defu', 'oxc-parser', 'vue', /^vue\//],
    },
  },
  // Runtime files are loaded by Nuxt/Nitro by path, so they stay one file per
  // source file (`unbundle`) with every virtual `#…` alias left for Nuxt to resolve.
  // `.js` + `.d.ts` so extension-less imports in Nuxt's generated types resolve.
  {
    entry: ['src/runtime/**/*.ts', '!src/runtime/**/*.d.ts'],
    unbundle: true,
    root: 'src/runtime',
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outDir: 'dist/runtime',
    fixedExtension: false,
    clean: true,
    tsconfig: 'tsconfig.build.json',
    dts: true,
    deps: {
      neverBundle: [/^#/, 'nuxt', /^nuxt\//, 'vue', 'h3', 'nitropack', /^nitropack\//],
    },
  },
])
