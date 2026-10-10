# nuxt

Monorepo for the `@mono-lit` Nuxt packages. Its layout follows the `libs` and `pro` monorepos
(pnpm workspace + Vite+ task runner).

| Package | Folder | Purpose |
| --- | --- | --- |
| `@mono-lit/nuxt-pre-fetch` | `packages/nuxt-pre-fetch` | Nitro-side API prefetching for `ssr: false` Nuxt apps: `usePreFetch()` (≈ `useFetch`) reuses data embedded in the SPA shell, so the initial page load makes no API request from the browser. |

## Scripts

```sh
pnpm bootstrap            # install + build every library
pnpm build                # vp run lib:all (cached)
pnpm dev                  # nuxt-pre-fetch playground (nuxi dev)
pnpm typecheck            # package + playground type checks
pnpm test                 # build, then unit + e2e (production build + Playwright Chromium)
pnpm test:unit
pnpm test:e2e
pnpm nuxt-pre-fetch <script>  # run any script inside packages/nuxt-pre-fetch
pnpm clean                # drop dist/ + Nuxt build folders + the vp cache
```

The e2e tests need Chromium: `npx playwright-core install chromium`.

## License

MIT. See [LICENSE.md](LICENSE.md).
