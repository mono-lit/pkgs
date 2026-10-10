import { describe, expect, it } from 'vitest'
import { isStaticPreset, staticReason } from '../../src/build/static'

describe('static output detection', () => {
  it('recognises static Nitro presets in either spelling', () => {
    for (const preset of ['static', 'github_pages', 'github-pages', 'gitlab_pages', 'cloudflare_pages_static', 'cloudflare-pages-static', 'netlify-static', 'vercel_static', ' Static '])
      expect(isStaticPreset(preset), preset).toBe(true)
    for (const preset of ['node_server', 'node-server', 'cloudflare_module', 'cloudflare-pages', 'netlify', 'vercel', 'bun', '', undefined, null, 42])
      expect(isStaticPreset(preset), String(preset)).toBe(false)
  })

  it('a static preset turns the server off at build time only; `nuxi generate` too', () => {
    expect(staticReason({ nitro: { preset: 'static' } })).toMatch(/static Nitro preset "static".*ssr: false can stay/)
    expect(staticReason({ dev: true, nitro: { preset: 'static' } })).toBeUndefined()
    expect(staticReason({ _generate: true })).toMatch(/static generation/)
    expect(staticReason({ nitro: { static: true } })).toMatch(/static generation/)
    expect(staticReason({ nitro: { preset: 'node_server' } })).toBeUndefined()
    expect(staticReason({})).toBeUndefined()
  })
})
