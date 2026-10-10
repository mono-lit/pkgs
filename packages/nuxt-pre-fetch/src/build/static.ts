// Static output (`nuxi generate`, or `nuxi build` with a static Nitro preset) is plain files on
// a host: nothing runs at request time, so nothing can prefetch, and the module's endpoints
// (`/__nuxt_pre_fetch`, `/__nuxt_pre_fetch/learn`) would 404 there.

/** Nitro presets whose output is static files only (spelled with `_` or `-`). */
const STATIC_PRESETS = new Set(['static', 'github_pages', 'gitlab_pages'])

/** Whether a Nitro preset name is a static-files preset (`static`, `*_static`, GitHub/GitLab Pages). */
export function isStaticPreset(preset: unknown): boolean {
  if (typeof preset !== 'string' || !preset) return false
  const name = preset.trim().toLowerCase().replace(/-/g, '_')
  return STATIC_PRESETS.has(name) || name.endsWith('_static')
}

/** Why a build gets no request-time server, or `undefined` when it gets one. */
export function staticReason(options: { dev?: boolean, _generate?: boolean, nitro?: { static?: boolean, preset?: unknown } }): string | undefined {
  if (options.dev) return undefined // `nuxi dev` always runs Nitro, whatever the build target
  if (options._generate || options.nitro?.static) return 'static generation has no request-time server'
  if (isStaticPreset(options.nitro?.preset)) return `the static Nitro preset "${String(options.nitro!.preset)}" has no request-time server — build with a server preset (e.g. node_server, cloudflare_module); ssr: false can stay`
  return undefined
}
