import { parseSync } from 'oxc-parser'
import { parse as parseSFC } from 'vue/compiler-sfc'
import type { ManifestRequest, QuerySource, UrlPart } from '../runtime/shared/types'

export const COMPOSABLE_NAME = 'usePreFetch'

export interface AnalyzerWarning {
  /** 1-based line in the original file. */
  line: number
  message: string
}

export interface AnalysisResult {
  requests: ManifestRequest[]
  warnings: AnalyzerWarning[]
}

/** A plain function call that runs while the scope sets up, e.g. `useUsersStore()`. */
export interface CallSite {
  name: string
  line: number
}

/** `import { imported as local } from 'source'` (`imported` is `'default'` for default imports). */
export interface ImportBinding {
  source: string
  imported: string
}

/** One setup scope: a page's `<script setup>`, a composable, or a Pinia setup store. */
export interface ScopeAnalysis extends AnalysisResult {
  /** Top-level calls that may be other providers (stores, composables) to follow. */
  calls: CallSite[]
}

export interface PageAnalysis extends ScopeAnalysis {
  imports: Record<string, ImportBinding>
}

export interface ProviderAnalysis extends ScopeAnalysis {
  /** Pinia store id when the provider is `defineStore('<id>', () => { … })`. */
  storeId?: string
}

/** A store/composable module: its functions that can run `usePreFetch` during setup. */
export interface ModuleAnalysis {
  imports: Record<string, ImportBinding>
  /** By local name. */
  providers: Record<string, ProviderAnalysis>
  /** Exported name → local name (`'default'` for the default export). */
  exports: Record<string, string>
  warnings: AnalyzerWarning[]
}

// Minimal ESTree shape — oxc returns plain objects with `type`, `start`, `end`.
interface Node {
  type: string
  start: number
  end: number
  [key: string]: any
}

/** Options that only influence the browser side and never the request itself. */
const CLIENT_ONLY_OPTIONS = new Set([
  'key', 'lazy', 'default', 'transform', 'pick', 'watch', 'immediate', 'deep', 'dedupe', 'timeout',
  'getCachedData', 'enabled', 'server', 'onRequest', 'onRequestError', 'onResponse', 'onResponseError',
  'retry', 'retryDelay', 'retryStatusCodes', 'parseResponse', 'ignoreResponseError', 'credentials',
  'mode', 'cache', 'signal', 'priority', 'keepalive', 'redirect', 'referrer', 'referrerPolicy', 'integrity',
])

class Unsupported extends Error {}

function fail(message: string): never {
  throw new Unsupported(message)
}

function unwrapExpression(node: Node): Node {
  let current = node
  while (
    current.type === 'TSAsExpression' || current.type === 'TSNonNullExpression'
    || current.type === 'TSSatisfiesExpression' || current.type === 'TSTypeAssertion'
    || current.type === 'ParenthesizedExpression'
  ) {
    current = current.expression
  }
  return current
}

function propertyName(node: Node, computed: boolean): string | null {
  if (!computed && node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  return null
}

function lineOf(source: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

function langOf(filename: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  return /\.tsx$/.test(filename) ? 'tsx' : /\.jsx$/.test(filename) ? 'jsx' : /\.[mc]?ts$/.test(filename) ? 'ts' : 'js'
}

/** Analyzes one page file. Never executes any of its code. */
export function analyzeSFC(source: string, filename: string): PageAnalysis {
  if (!filename.endsWith('.vue')) {
    return analyzeScript(source, filename, 0, langOf(filename), source)
  }
  const { descriptor } = parseSFC(source, { filename, sourceMap: false, ignoreEmpty: true })
  const result: PageAnalysis = { requests: [], warnings: [], calls: [], imports: {} }
  const setup = descriptor.scriptSetup
  if (setup) {
    const lang = setup.lang === 'tsx' ? 'tsx' : setup.lang === 'ts' ? 'ts' : setup.lang === 'jsx' ? 'jsx' : 'js'
    const analyzed = analyzeScript(setup.content, filename, setup.loc.start.offset, lang, source)
    result.requests.push(...analyzed.requests)
    result.warnings.push(...analyzed.warnings)
    result.calls.push(...analyzed.calls)
    Object.assign(result.imports, analyzed.imports)
  }
  const script = descriptor.script
  if (script && script.content.includes(COMPOSABLE_NAME)) {
    result.warnings.push({
      line: script.loc.start.line,
      message: `${COMPOSABLE_NAME}() in a non-setup <script> is not analysed; it falls back to a client fetch.`,
    })
  }
  return result
}

/** Quick pre-check: could this code reach `usePreFetch`, directly or through a `useX()` call? */
const MAY_PREFETCH = /usePreFetch|\buse[A-Z]\w*\s*\(/

/**
 * Finds `usePreFetch()` calls that run unconditionally while the page sets up:
 * statements at the top level of the script (not inside functions, callbacks,
 * branches or loops) and turns their statically known parts into manifest
 * requests. Anything else becomes a warning and falls back to a client fetch.
 * Also records top-level calls (`useUsersStore()`, `useUsers()`) and imports, so
 * the manifest builder can follow them into stores and composables.
 */
export function analyzeScript(
  code: string,
  filename: string,
  offset: number,
  lang: 'js' | 'jsx' | 'ts' | 'tsx',
  fullSource: string,
): PageAnalysis {
  const analyzed = analyzeProgram(code, filename, offset, lang, fullSource, 'page')
  return { ...analyzed.page!, imports: analyzed.imports }
}

/**
 * Analyzes a store/composable module (`stores/users.ts`, `composables/useUsers.ts`):
 * every top-level function, `const fn = () => …` and Pinia setup store
 * (`defineStore('id', () => { … })`) becomes a provider whose setup-time
 * `usePreFetch()` calls and further calls are recorded. Never executes the module.
 */
export function analyzeModule(source: string, filename: string): ModuleAnalysis {
  const analyzed = analyzeProgram(source, filename, 0, langOf(filename), source, 'module')
  return { imports: analyzed.imports, providers: analyzed.providers, exports: analyzed.exports, warnings: analyzed.warnings }
}

function analyzeProgram(
  code: string,
  filename: string,
  offset: number,
  lang: 'js' | 'jsx' | 'ts' | 'tsx',
  fullSource: string,
  mode: 'page' | 'module',
): { page?: ScopeAnalysis, imports: Record<string, ImportBinding>, providers: Record<string, ProviderAnalysis>, exports: Record<string, string>, warnings: AnalyzerWarning[] } {
  const imports: Record<string, ImportBinding> = {}
  const providers: Record<string, ProviderAnalysis> = {}
  const exportsMap: Record<string, string> = {}
  const empty = () => ({ page: mode === 'page' ? { requests: [], warnings: [], calls: [] } as ScopeAnalysis : undefined, imports, providers, exports: exportsMap, warnings: [] as AnalyzerWarning[] })
  if (!MAY_PREFETCH.test(code)) return empty()

  const parsed = parseSync(`${filename}.${lang}`, code, { lang, sourceType: 'module' })
  if (parsed.errors.length) {
    const out = empty()
    const warning = { line: lineOf(fullSource, offset), message: `could not parse script: ${parsed.errors[0]!.message}` }
    if (out.page) out.page.warnings.push(warning)
    else out.warnings.push(warning)
    return out
  }
  const program = parsed.program as unknown as Node
  const line = (node: Node) => lineOf(fullSource, offset + node.start)

  // Identifiers bound to the current route: `useRoute()`, or `useRouter().currentRoute.value`
  // (the reliable one inside Pinia stores). Both functions may be imported under an alias.
  const useRouteNames = new Set(['useRoute'])
  const useRouterNames = new Set(['useRouter'])
  const defineStoreNames = new Set(['defineStore'])
  const routeVars = new Set<string>()
  const routerVars = new Set<string>()
  let shadowed = false
  for (const statement of program.body as Node[]) {
    if (statement.type === 'ImportDeclaration') {
      for (const spec of statement.specifiers as Node[]) {
        if (spec.type === 'ImportSpecifier') {
          const imported = propertyName(spec.imported, false) ?? spec.local.name
          imports[spec.local.name] = { source: statement.source.value, imported }
          if (imported === 'useRoute') useRouteNames.add(spec.local.name)
          if (imported === 'useRouter') useRouterNames.add(spec.local.name)
          if (imported === 'defineStore') defineStoreNames.add(spec.local.name)
        }
        else if (spec.type === 'ImportDefaultSpecifier') {
          imports[spec.local.name] = { source: statement.source.value, imported: 'default' }
        }
        if (spec.local?.name === COMPOSABLE_NAME) shadowed = true
      }
    }
    if (statement.type === 'FunctionDeclaration' && statement.id?.name === COMPOSABLE_NAME) shadowed = true
  }
  if (shadowed) return empty()

  const isCallOf = (node: Node | undefined, names: Set<string>) => !!node && node.type === 'CallExpression'
    && node.callee.type === 'Identifier' && names.has(node.callee.name) && node.arguments.length === 0

  /** `useRouter()` or a variable bound to it. */
  const isRouter = (node: Node): boolean => {
    const target = unwrapExpression(node)
    return target.type === 'Identifier' ? routerVars.has(target.name) : isCallOf(target, useRouterNames)
  }

  /** `useRoute()`, `<router>.currentRoute.value`, or a variable bound to either. */
  const isRouteObject = (node: Node): boolean => {
    const target = unwrapExpression(node)
    if (target.type === 'Identifier') return routeVars.has(target.name)
    if (isCallOf(target, useRouteNames)) return true
    if (target.type !== 'MemberExpression' || propertyName(target.property, target.computed) !== 'value') return false
    const current = unwrapExpression(target.object)
    return current.type === 'MemberExpression' && propertyName(current.property, current.computed) === 'currentRoute' && isRouter(current.object)
  }

  /** Adds `const route = useRoute()` / `useRouter().currentRoute.value` and `const router = useRouter()` bindings. */
  const collectRouteVars = (statements: Node[]) => {
    for (const statement of statements) {
      if (statement.type !== 'VariableDeclaration') continue
      for (const declarator of statement.declarations as Node[]) {
        if (declarator.id.type !== 'Identifier' || !declarator.init) continue
        const init = unwrapExpression(declarator.init)
        if (isCallOf(init, useRouterNames)) routerVars.add(declarator.id.name)
        else if (isRouteObject(init)) routeVars.add(declarator.id.name)
      }
    }
  }
  collectRouteVars(program.body as Node[])

  /** Where requests, warnings and calls of the scope being walked go. */
  let sink: ScopeAnalysis = { requests: [], warnings: [], calls: [] }

  /** `route.params.id` → `{ kind: 'params', name: 'id' }` (also `useRoute().query.page`). */
  const routeAccess = (node: Node): { kind: 'params' | 'query', name: string } | null => {
    const target = unwrapExpression(node)
    if (target.type !== 'MemberExpression' || target.optional) return null
    const name = propertyName(target.property, target.computed)
    const parent = unwrapExpression(target.object)
    if (!name || parent.type !== 'MemberExpression') return null
    const kind = propertyName(parent.property, parent.computed)
    if ((kind !== 'params' && kind !== 'query') || !isRouteObject(parent.object)) return null
    return { kind, name }
  }

  const literal = (node: Node): { ok: true, value: unknown } | { ok: false } => {
    const target = unwrapExpression(node)
    if (target.type === 'Literal' && !('regex' in target && target.regex) && typeof target.value !== 'bigint') return { ok: true, value: target.value }
    if (target.type === 'TemplateLiteral' && target.expressions.length === 0) return { ok: true, value: target.quasis[0].value.cooked }
    if (target.type === 'UnaryExpression' && target.operator === '-' && target.argument.type === 'Literal' && typeof target.argument.value === 'number') {
      return { ok: true, value: -target.argument.value }
    }
    if (target.type === 'ArrayExpression') {
      const values: unknown[] = []
      for (const element of target.elements as Array<Node | null>) {
        if (!element || element.type === 'SpreadElement') return { ok: false }
        const item = literal(element)
        if (!item.ok) return { ok: false }
        values.push(item.value)
      }
      return { ok: true, value: values }
    }
    return { ok: false }
  }

  /** Set while walking the callback of a list query `.split(sep).map(item => …)`. */
  let listBinding: { name: string, q: string, sep: string, max?: number } | null = null

  /** `route.query.x`, optionally as `String(…)`, `(… ?? '')` or `(… || '')` → `x`. */
  const listQuerySource = (input: Node): string | null => {
    let node = unwrapExpression(input)
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'String' && node.arguments.length === 1) {
      node = unwrapExpression(node.arguments[0])
    }
    if (node.type === 'LogicalExpression' && (node.operator === '??' || node.operator === '||')) {
      const fallback = literal(node.right)
      if (!fallback.ok || fallback.value !== '') return null
      node = unwrapExpression(node.left)
    }
    const access = routeAccess(node)
    return access?.kind === 'query' ? access.name : null
  }

  /**
   * `String(route.query.ids ?? '').split(',').map(id => …)`: a list query whose callback
   * runs once per item while the page sets up.
   */
  const listMap = (node: Node): { fn: Node, name: string, q: string, sep: string, max?: number } | null => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.optional) return null
    if (propertyName(node.callee.property, node.callee.computed) !== 'map') return null
    let split = unwrapExpression(node.callee.object)
    // Optional cap between split and map: `.split(',').slice(0, 250).map(…)` (literal bounds).
    let max: number | undefined
    if (split.type === 'CallExpression' && split.callee.type === 'MemberExpression' && propertyName(split.callee.property, split.callee.computed) === 'slice') {
      const [start, end] = (split.arguments as Node[]).map(argument => literal(argument))
      if (split.arguments.length !== 2 || !start?.ok || start.value !== 0 || !end?.ok || typeof end.value !== 'number' || !Number.isInteger(end.value) || end.value < 0) return null
      max = end.value
      split = unwrapExpression(split.callee.object)
    }
    if (split.type !== 'CallExpression' || split.callee.type !== 'MemberExpression' || propertyName(split.callee.property, split.callee.computed) !== 'split') return null
    const separator = split.arguments[0] && literal(split.arguments[0])
    if (!separator?.ok || typeof separator.value !== 'string' || !separator.value) return null
    const q = listQuerySource(split.callee.object)
    const fn = node.arguments[0] as Node | undefined
    if (!q || !fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) return null
    const param = fn.params[0] as Node | undefined
    if (param?.type !== 'Identifier') return null
    return { fn, name: param.name, q, sep: separator.value, max }
  }

  const evaluateURL = (input: Node): UrlPart[] => {
    let node = unwrapExpression(input)
    if (node.type === 'ArrowFunctionExpression' && node.params.length === 0) {
      if (node.body.type === 'BlockStatement') {
        const body = node.body.body as Node[]
        if (body.length !== 1 || body[0]!.type !== 'ReturnStatement' || !body[0]!.argument) fail('URL getter must be a single return of a string or template literal')
        node = unwrapExpression(body[0]!.argument)
      }
      else {
        node = unwrapExpression(node.body)
      }
    }
    if (node.type === 'Literal' && typeof node.value === 'string') return [node.value]
    if (node.type === 'TemplateLiteral') {
      const parts: UrlPart[] = []
      node.quasis.forEach((quasi: Node, index: number) => {
        if (quasi.value.cooked) parts.push(quasi.value.cooked)
        const expression = node.expressions[index] as Node | undefined
        if (!expression) return
        const target = unwrapExpression(expression)
        if (listBinding && target.type === 'Identifier' && target.name === listBinding.name) {
          parts.push({ item: true })
          return
        }
        const access = routeAccess(expression)
        if (!access) fail('URL template may only interpolate `route.params.<name>`, `route.query.<name>` or a list item')
        parts.push(access.kind === 'params' ? { p: access.name } : { q: access.name })
      })
      if (typeof parts[0] !== 'string') fail('URL must start with a static path or origin')
      return parts
    }
    return fail('URL must be a string literal, a template literal over `route.params`/`route.query`, or a getter returning one')
  }

  /** `computed(() => expr)` → `expr` (reactive values `useFetch` unwraps itself). */
  const computedBody = (input: Node): Node | null => {
    const node = unwrapExpression(input)
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'computed') return null
    const [getter] = node.arguments as Node[]
    if (node.arguments.length !== 1 || getter?.type !== 'ArrowFunctionExpression' || getter.params.length || getter.body.type === 'BlockStatement') return null
    return unwrapExpression(getter.body)
  }

  const evaluateQuery = (input: Node, optionName: string): Record<string, QuerySource> => {
    let node = unwrapExpression(input)
    // Whole reactive query: `computed(() => ({ ... }))` or a getter `() => ({ ... })`.
    const reactiveQuery = computedBody(node)
      ?? (node.type === 'ArrowFunctionExpression' && !node.params.length && node.body.type !== 'BlockStatement' ? unwrapExpression(node.body) : null)
    if (reactiveQuery) node = reactiveQuery
    if (node.type !== 'ObjectExpression') fail(`\`${optionName}\` must be an object literal`)
    const out: Record<string, QuerySource> = {}
    for (const property of node.properties as Node[]) {
      if (property.type !== 'Property' || property.kind !== 'init') fail(`\`${optionName}\` may not contain spreads or accessors`)
      const name = propertyName(property.key, property.computed)
      if (name === null) fail(`\`${optionName}\` keys must be static`)
      const value = computedBody(property.value) ?? property.value
      const access = routeAccess(value)
      if (access) {
        out[name] = access.kind === 'query' ? { rq: access.name } : { rp: access.name }
        continue
      }
      const constant = literal(value)
      if (!constant.ok) fail(`\`${optionName}.${name}\` must be a literal or \`route.query/params.<name>\``)
      out[name] = { v: constant.value }
    }
    return out
  }

  const analyzeCall = (call: Node): ManifestRequest | null => {
    const [urlArg, optionsArg] = call.arguments as Node[]
    if (!urlArg || urlArg.type === 'SpreadElement') fail('missing URL argument')
    let url = evaluateURL(urlArg)
    const request: ManifestRequest = { url, source: `${filename}:${line(call)}` }
    if (listBinding && url.some(part => typeof part === 'object' && 'item' in part)) {
      request.each = listBinding.max === undefined
        ? { q: listBinding.q, sep: listBinding.sep }
        : { q: listBinding.q, sep: listBinding.sep, max: listBinding.max }
    }

    if (optionsArg && !(optionsArg.type === 'Literal' && typeof optionsArg.value === 'string')) {
      const options = unwrapExpression(optionsArg)
      if (options.type !== 'ObjectExpression') fail('options must be an object literal')
      let query: Record<string, QuerySource> | undefined
      let pick: string[] | undefined
      let hasTransform = false
      for (const property of options.properties as Node[]) {
        if (property.type !== 'Property' || property.kind !== 'init') fail('options may not contain spreads or accessors')
        const name = propertyName(property.key, property.computed)
        if (name === null) fail('option names must be static')
        if (CLIENT_ONLY_OPTIONS.has(name)) {
          if (name === 'transform') hasTransform = true
          if (name === 'pick') {
            const value = literal(property.value)
            if (value.ok && Array.isArray(value.value) && value.value.every(key => typeof key === 'string')) pick = value.value as string[]
          }
          if (name === 'server') {
            const value = literal(property.value)
            if (value.ok && value.value === false) return null // explicitly client-only
          }
          continue
        }
        switch (name) {
          case 'method': {
            const value = literal(property.value)
            if (!value.ok || typeof value.value !== 'string') fail('`method` must be a string literal')
            if (value.value.toUpperCase() !== 'GET') fail(`only GET requests are prefetched (got ${value.value})`)
            break
          }
          case 'query':
          case 'params':
            query = { ...query, ...evaluateQuery(property.value, name) }
            break
          case 'headers': {
            const headers = unwrapExpression(property.value)
            if (headers.type !== 'ObjectExpression') fail('`headers` must be an object literal')
            request.headers = {}
            for (const header of headers.properties as Node[]) {
              const headerName = header.type === 'Property' ? propertyName(header.key, header.computed) : null
              const value = header.type === 'Property' ? literal(header.value) : { ok: false as const }
              if (!headerName || !value.ok || typeof value.value !== 'string') fail('`headers` must map static names to string literals')
              request.headers[headerName.toLowerCase()] = value.value
            }
            break
          }
          case 'baseURL': {
            const value = literal(property.value)
            if (!value.ok || typeof value.value !== 'string') fail('`baseURL` must be a string literal')
            const base = value.value
            const [first, ...rest] = url
            if (typeof first === 'string' && /^[a-z][a-z\d+\-.]*:\/\//i.test(first)) break
            url = [base.replace(/\/+$/, '') + '/' + String(first).replace(/^\/+/, ''), ...rest]
            request.url = url
            break
          }
          case 'responseType': {
            const value = literal(property.value)
            if (!value.ok || value.value !== 'json') fail('only JSON responses are prefetched')
            break
          }
          case 'body':
            fail('requests with a body are not prefetched')
            break
          case '$fetch':
            fail('a custom `$fetch` cannot run on the server')
            break
          default:
            fail(`option \`${name}\` is not statically supported`)
        }
      }
      if (query && Object.keys(query).length) request.query = query
      // `pick` without `transform` applies to the raw response, so Nitro can trim it
      // before embedding; the browser re-applies the same (idempotent) pick.
      if (pick && !hasTransform) request.pick = pick
    }

    const head = request.url[0] as string
    if (!head.startsWith('/') && !/^https?:\/\//i.test(head)) fail('URL must be absolute (`/api/...` or `https://...`)')
    if (head.startsWith('//')) fail('protocol-relative URLs are not supported')
    if (/^https?:\/\//i.test(head) && request.url.length > 1 && !/^https?:\/\/[^/?#]+\//i.test(head)) {
      fail('the origin of an absolute URL must be static')
    }
    return request
  }

  const isTarget = (node: Node) => node.type === 'CallExpression'
    && node.callee.type === 'Identifier' && node.callee.name === COMPOSABLE_NAME

  const FUNCTION_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration', 'ClassDeclaration', 'ClassExpression'])
  const CONDITIONAL_TYPES = new Set(['IfStatement', 'ConditionalExpression', 'LogicalExpression', 'SwitchStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'TryStatement'])

  const walk = (node: Node | null | undefined, context: 'top' | 'nested' | 'conditional') => {
    if (!node || typeof node.type !== 'string') return
    // A list-query map at the top level: its callback runs once per item during setup,
    // so calls directly inside it are analysed with the item bound (one level only).
    const list = context === 'top' && !listBinding ? listMap(node) : null
    if (list) {
      walk(node.callee.object, 'top')
      listBinding = { name: list.name, q: list.q, sep: list.sep, max: list.max }
      try {
        walk(list.fn.body, 'top')
      }
      finally {
        listBinding = null
      }
      return
    }
    if (isTarget(node)) {
      if (context === 'top') {
        try {
          const request = analyzeCall(node)
          if (request) sink.requests.push(request)
        }
        catch (error) {
          if (!(error instanceof Unsupported)) throw error
          sink.warnings.push({ line: line(node), message: `${COMPOSABLE_NAME}() is not prefetched: ${error.message}. It falls back to a client fetch.` })
        }
      }
      else {
        sink.warnings.push({
          line: line(node),
          message: `${COMPOSABLE_NAME}() inside a ${context === 'nested' ? 'function' : 'branch or loop'} is not prefetched; it falls back to a client fetch.`,
        })
      }
    }
    else if (context === 'top' && node.type === 'CallExpression' && node.callee.type === 'Identifier' && /^use[A-Z0-9]/.test(node.callee.name)) {
      // A composable or store used while this scope sets up: may lead to more usePreFetch calls.
      sink.calls.push({ name: node.callee.name, line: line(node) })
    }
    const nextContext = FUNCTION_TYPES.has(node.type) ? 'nested' : context === 'top' && CONDITIONAL_TYPES.has(node.type) ? 'conditional' : context
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
      const child = node[key]
      if (Array.isArray(child)) for (const item of child) walk(item, nextContext)
      else if (child && typeof child === 'object') walk(child as Node, nextContext)
    }
  }
  if (mode === 'page') {
    for (const statement of program.body as Node[]) walk(statement, 'top')
    return { page: sink, imports, providers, exports: exportsMap, warnings: [] }
  }

  // ---- module: providers ---------------------------------------------------------------
  /** The setup-time body of a provider: its statements, or an expression body. */
  const analyzeProvider = (localName: string, fn: Node, storeId?: string) => {
    sink = { requests: [], warnings: [], calls: [] }
    const statements: Node[] = fn.body.type === 'BlockStatement'
      ? fn.body.body
      : [{ type: 'ExpressionStatement', start: fn.body.start, end: fn.body.end, expression: fn.body }]
    collectRouteVars(statements)
    for (const statement of statements) walk(statement, 'top')
    providers[localName] = storeId ? { ...sink, storeId } : sink
  }

  const isFunction = (node: Node | undefined): node is Node => !!node && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration')

  /** `defineStore('id', () => { … })`: a Pinia setup store (option stores have no setup scope). */
  const setupStore = (node: Node | undefined): { id: string, setup: Node } | null => {
    const call = node && unwrapExpression(node)
    if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier' || !defineStoreNames.has(call.callee.name)) return null
    const [idArg, setup] = call.arguments as Node[]
    const id = idArg && literal(idArg)
    if (!id?.ok || typeof id.value !== 'string' || !isFunction(setup)) return null
    return { id: id.value, setup }
  }

  /** Registers a top-level declaration as a provider when it is a function or setup store. */
  const declare = (localName: string, value: Node | undefined) => {
    const target = value && unwrapExpression(value)
    const store = setupStore(target)
    if (store) analyzeProvider(localName, store.setup, store.id)
    else if (isFunction(target)) analyzeProvider(localName, target)
  }

  for (const statement of program.body as Node[]) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration as Node | null : statement
    if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
      declare(declaration.id.name, declaration)
      if (statement.type === 'ExportNamedDeclaration') exportsMap[declaration.id.name] = declaration.id.name
    }
    else if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations as Node[]) {
        if (declarator.id.type !== 'Identifier') continue
        declare(declarator.id.name, declarator.init)
        if (statement.type === 'ExportNamedDeclaration') exportsMap[declarator.id.name] = declarator.id.name
      }
    }
    if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
      for (const spec of (statement.specifiers ?? []) as Node[]) {
        const local = propertyName(spec.local, false)
        const exported = propertyName(spec.exported, false)
        if (local && exported) exportsMap[exported] = local
      }
    }
    if (statement.type === 'ExportDefaultDeclaration') {
      const value = statement.declaration as Node
      if (value.type === 'Identifier') exportsMap.default = value.name
      else {
        declare('#default', value)
        exportsMap.default = '#default'
      }
    }
  }
  return { imports, providers, exports: exportsMap, warnings: [] }
}
