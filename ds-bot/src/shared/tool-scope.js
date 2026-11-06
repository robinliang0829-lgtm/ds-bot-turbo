// Adapted from OpenMausBot shared/tool-scope.ts, licensed under Apache-2.0:
// https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/shared/tool-scope.ts
// Changes for DS Bot Turbo: JavaScript, no agents aggregate aliases, getter-safe
// validation, and a conservative adapter for DSH's public tool names.

/** @typedef {{ allow?: string[], deny?: string[] }} ToolScope */
/** @typedef {{ kind: 'native', name: string } | { kind: 'mcp', server: string, name: string }} ToolIdentity */

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/
// Selectors must never contain protocol control characters.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/
const MAX_SELECTORS = 256
const MAX_SELECTOR_LENGTH = 1024
const DSH_NAME = /^[A-Za-z0-9_-]{1,64}$/
const DSH_HASH_SUFFIX = /_[a-f0-9]{12}$/

function validName(name) {
  return typeof name === 'string' && name.trim().length > 0
    && name.length <= MAX_SELECTOR_LENGTH && !CONTROL_CHARACTER.test(name)
    && !name.includes('*')
}

function validServer(server) {
  return typeof server === 'string' && SERVER_NAME.test(server)
}

function selectorIdentity(selector) {
  if (typeof selector !== 'string' || selector.length > MAX_SELECTOR_LENGTH || CONTROL_CHARACTER.test(selector)) return
  if (selector.startsWith('native:')) {
    const name = selector.slice(7)
    if (name === '*' || validName(name)) return { kind: 'native', name }
  } else if (selector.startsWith('mcp:')) {
    const separator = selector.indexOf(':', 4)
    if (separator < 0) return
    const server = selector.slice(4, separator)
    const name = selector.slice(separator + 1)
    if (validServer(server) && (name === '*' || validName(name))) {
      return { kind: 'mcp', server, name }
    }
  }
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readList(value, accepts, limit = MAX_SELECTORS) {
  try {
    if (!Array.isArray(value)) return
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) return
    if (Reflect.ownKeys(value).length !== length + 1) return
    const result = []
    for (let index = 0; index < length; index++) {
      // Reading descriptors rejects holes and accessors without executing an
      // element getter or a caller-supplied iterator during validation/copying.
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !('value' in descriptor) || !accepts(descriptor.value)) return
      result.push(descriptor.value)
    }
    return result
  } catch {
    return undefined
  }
}

/**
 * Undefined inherits the existing catalog. A present invalid value never does.
 * @returns {{ ok: true, scope: ToolScope | undefined } | { ok: false, error: string }}
 */
export function parseToolScope(value) {
  if (value === undefined) return { ok: true, scope: undefined }
  const invalid = { ok: false, error: 'Tool selection must contain only valid allow and deny lists.' }
  try {
    if (!plainRecord(value)) return invalid
    const scope = {}
    for (const key of Reflect.ownKeys(value)) {
      if (key !== 'allow' && key !== 'deny') return invalid
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return invalid
      const list = readList(descriptor.value, selectorIdentity)
      if (list === undefined) return invalid
      scope[key] = [...new Set(list)]
    }
    return { ok: true, scope }
  } catch {
    return invalid
  }
}

function readToolIdentity(value) {
  try {
    if (!plainRecord(value)) return
    const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value
    const name = Object.getOwnPropertyDescriptor(value, 'name')?.value
    if (!validName(name)) return
    if (kind === 'native') return { kind, name }
    const server = Object.getOwnPropertyDescriptor(value, 'server')?.value
    if (kind === 'mcp' && validServer(server)) return { kind, server, name }
  } catch {
    return undefined
  }
}

/**
 * Convert an unambiguous DSH public name to a selector identity; otherwise reject.
 * DSH replaces/truncates lossy MCP names and appends a 12-hex identity hash.
 * Recovering those names requires host metadata, so even a literal hash-shaped
 * suffix is conservatively rejected. Never treat a bad MCP name as native.
 * @returns {ToolIdentity | undefined}
 */
export function dshToolIdentity(name) {
  if (typeof name !== 'string' || !DSH_NAME.test(name)) return
  if (!name.startsWith('mcp__')) return { kind: 'native', name }
  const parts = name.split('__')
  if (parts.length !== 3 || name.includes('___') || !validServer(parts[1])
    || !validName(parts[2]) || DSH_HASH_SUFFIX.test(name)) return
  return { kind: 'mcp', server: parts[1], name: parts[2] }
}

function matches(selector, tool) {
  const selected = selectorIdentity(selector)
  return selected?.kind === tool.kind
    && (selected.kind !== 'mcp' || (tool.kind === 'mcp' && selected.server === tool.server))
    && (selected.name === '*' || selected.name === tool.name)
}

function permits(scope, tool) {
  return (scope?.allow === undefined || scope.allow.some(selector => matches(selector, tool)))
    && !scope?.deny?.some(selector => matches(selector, tool))
}

/** Whether this exact tool is selected. DS Bot tools have no aggregate aliases. */
export function allowsTool(scope, tool) {
  const parsed = parseToolScope(scope)
  const identity = readToolIdentity(tool)
  return parsed.ok && identity !== undefined && permits(parsed.scope, identity)
}

/** Whether an engine needs a native catalog contract, in addition to MCP gates. */
export function narrowsNativeTools(value) {
  const parsed = parseToolScope(value)
  if (!parsed.ok) return true
  const scope = parsed.scope
  return scope !== undefined && ((scope.allow !== undefined && !scope.allow.includes('native:*'))
    || Boolean(scope.deny?.some(selector => selector.startsWith('native:'))))
}

/** Without a catalog, asks whether this server could have a permitted tool. */
export function canUseMcpServer(scope, server, names) {
  const parsed = parseToolScope(scope)
  if (!parsed.ok || !validServer(server)) return false
  if (names !== undefined) {
    const catalog = readList(names, validName, Infinity)
    return catalog !== undefined && catalog.some(name => permits(parsed.scope, { kind: 'mcp', server, name }))
  }
  if (parsed.scope?.deny?.includes(`mcp:${server}:*`)) return false
  if (parsed.scope?.allow === undefined) return true
  return parsed.scope.allow.some(selector => {
    const selected = selectorIdentity(selector)
    return selected?.kind === 'mcp' && selected.server === server
      && (selected.name === '*' || permits(parsed.scope, selected))
  })
}

/** Compare selector partitions, including a tool/server outside all exact names. */
export function toolScopeWidens(previous, next) {
  const before = parseToolScope(previous)
  const after = parseToolScope(next)
  if (!after.ok) return false
  const namespaces = new Map([['native', new Set()]])
  const scopes = [before.ok ? before.scope : undefined, after.scope]
  for (const scope of scopes) {
    for (const selector of [...(scope?.allow ?? []), ...(scope?.deny ?? [])]) {
      const tool = selectorIdentity(selector)
      const namespace = tool.kind === 'native' ? 'native' : `mcp:${tool.server}`
      if (!namespaces.has(namespace)) namespaces.set(namespace, new Set())
      if (tool.name !== '*') namespaces.get(namespace).add(tool.name)
    }
  }
  let server = 'unlisted'
  for (let index = 0; namespaces.has(`mcp:${server}`); index++) server = `unlisted${index}`
  namespaces.set(`mcp:${server}`, new Set())
  for (const [namespace, names] of namespaces) {
    let other = '__unlisted_tool__'
    for (let index = 0; names.has(other); index++) other = `__unlisted_tool_${index}__`
    names.add(other)
    for (const name of names) {
      const tool = namespace === 'native' ? { kind: 'native', name }
        : { kind: 'mcp', server: namespace.slice(4), name }
      if (permits(after.scope, tool) && (!before.ok || !permits(before.scope, tool))) return true
    }
  }
  return false
}
