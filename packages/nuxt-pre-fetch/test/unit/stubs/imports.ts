// Minimal stand-ins for Nuxt/Nitro auto-imports used by the runtime under test.
export const runtimeState = {
  config: {
    app: { baseURL: '/' },
    nuxtPreFetch: { concurrency: 2, maxListItems: 3, timeout: 1000, external: { allowedHosts: ['api.example.com'], forwardHeaders: { 'api.example.com': ['authorization'] } } },
    public: { nuxtPreFetch: { enabled: true, debug: false, clientNavigation: true, fetchMode: 'client', fallback: 'client', endpoint: '/__nuxt_pre_fetch', navigationTimeout: 3000, keepPayload: false, streamNavigation: true } },
  } as any,
  hooks: [] as Array<(context: any) => void | Promise<void>>,
}

export function useRuntimeConfig(_event?: unknown) {
  return runtimeState.config
}

export function useNitroApp() {
  return {
    hooks: {
      callHook: async (_name: string, context: unknown) => {
        for (const hook of runtimeState.hooks) await hook(context)
      },
    },
  }
}

export function createError(input: { statusCode: number, statusMessage?: string, data?: unknown }) {
  return Object.assign(new Error(input.statusMessage ?? 'error'), input)
}

const storageData = new Map<string, unknown>()
export const storageState = { data: storageData }

export function useStorage(base = '') {
  const k = (key: string) => (base ? `${base}:${key}` : key)
  return {
    getItem: async <T>(key: string) => (storageData.has(k(key)) ? structuredClone(storageData.get(k(key))) as T : null),
    setItem: async (key: string, value: unknown) => {
      storageData.set(k(key), structuredClone(value))
    },
    removeItem: async (key: string) => {
      storageData.delete(k(key))
    },
  }
}
