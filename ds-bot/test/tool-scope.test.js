// Selector scenarios adapted from OpenMausBot, Apache-2.0:
// https://github.com/milind-soni/OpenMausBot/blob/fb31cb7dc56a90a00a6f07001219335a1afdff08/shared/tool-scope.test.ts
// Changes: node:test, independent DS Bot names, defensive input cases, and DSH
// public-name adaptation (including ambiguous and lossy names).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  allowsTool,
  canUseMcpServer,
  dshToolIdentity,
  narrowsNativeTools,
  parseToolScope,
  toolScopeWidens,
} from '../src/shared/tool-scope.js'

const native = name => ({ kind: 'native', name })
const mcp = (server, name) => ({ kind: 'mcp', server, name })

function assertInvalid(scope) {
  assert.deepEqual(parseToolScope(scope), {
    ok: false,
    error: 'Tool selection must contain only valid allow and deny lists.',
  })
  assert.equal(allowsTool(scope, native('read')), false)
  assert.equal(allowsTool(scope, mcp('notes', 'read')), false)
  assert.equal(canUseMcpServer(scope, 'notes'), false)
  assert.equal(canUseMcpServer(scope, 'notes', ['read']), false)
  assert.equal(narrowsNativeTools(scope), true)
  assert.equal(toolScopeWidens({ allow: [] }, scope), false)
  assert.equal(toolScopeWidens(scope, { allow: ['native:read'] }), true)
}

test('missing scope and absent allow preserve the existing catalog', () => {
  assert.deepEqual(parseToolScope(undefined), { ok: true, scope: undefined })
  for (const scope of [undefined, {}, { deny: [] }]) {
    assert.equal(allowsTool(scope, native('read')), true)
    assert.equal(allowsTool(scope, mcp('notes', 'read')), true)
    assert.equal(allowsTool(scope, native('message_bot')), true)
    assert.equal(canUseMcpServer(scope, 'notes'), true)
  }
})

test('an explicit empty allow disables all tools even with an empty deny', () => {
  for (const scope of [{ allow: [] }, { allow: [], deny: [] }]) {
    assert.equal(allowsTool(scope, native('read')), false)
    assert.equal(allowsTool(scope, mcp('notes', 'read')), false)
    assert.equal(canUseMcpServer(scope, 'notes'), false)
    assert.equal(canUseMcpServer(scope, 'notes', ['read']), false)
  }
})

test('allow selects exact native and server-qualified names', () => {
  const scope = { allow: ['native:read', 'native:write', 'mcp:notes:read'] }
  assert.equal(allowsTool(scope, native('read')), true)
  assert.equal(allowsTool(scope, native('write')), true)
  assert.equal(allowsTool(scope, native('pwsh')), false)
  assert.equal(allowsTool(scope, mcp('notes', 'read')), true)
  assert.equal(allowsTool(scope, mcp('notes', 'write')), false)
  assert.equal(allowsTool(scope, mcp('other', 'read')), false)
})

test('deny wins over an exact allow or a wildcard and deny-only inherits the rest', () => {
  for (const allow of [['native:read'], ['native:*']]) {
    assert.equal(allowsTool({ allow, deny: ['native:read'] }, native('read')), false)
  }
  const scope = { allow: ['mcp:mail:*'], deny: ['mcp:mail:send_mail'] }
  assert.equal(allowsTool(scope, mcp('mail', 'search_mail')), true)
  assert.equal(allowsTool(scope, mcp('mail', 'send_mail')), false)
  assert.equal(allowsTool({ allow: ['mcp:mail:search_mail'], deny: ['mcp:mail:*'] }, mcp('mail', 'search_mail')), false)
  assert.equal(allowsTool({ deny: ['native:pwsh'] }, native('read')), true)
  assert.equal(allowsTool({ deny: ['native:pwsh'] }, native('pwsh')), false)
  assert.equal(allowsTool({ deny: ['native:*'] }, mcp('notes', 'read')), true)
})

test('only the entire name field can be a wildcard', () => {
  const scope = { allow: ['native:*', 'mcp:notes:*'] }
  assert.equal(allowsTool(scope, native('write')), true)
  assert.equal(allowsTool(scope, mcp('notes', 'write')), true)
  assert.equal(allowsTool(scope, mcp('other', 'write')), false)
  for (const selector of ['*', '*:read', 'native:read*', 'native:*read', 'native:r*d', 'mcp:*:read', 'mcp:*:*', 'mcp:notes*:read', 'mcp:notes:read*', 'mcp:notes:**']) {
    assertInvalid({ allow: [selector] })
    assertInvalid({ deny: [selector] })
  }
})

test('original selector names retain case, punctuation, and namespace distinctions', () => {
  const scope = { allow: ['mcp:notes:read-notes', 'mcp:notes:namespace:read', 'native:read'] }
  assert.equal(allowsTool(scope, mcp('notes', 'read-notes')), true)
  assert.equal(allowsTool(scope, mcp('notes', 'namespace:read')), true)
  for (const tool of [mcp('notes', 'read_notes'), mcp('notes', 'Read-notes'), mcp('notes-other', 'read-notes'), native('notes_read_notes'), mcp('notes', 'read')]) {
    assert.equal(allowsTool(scope, tool), false)
  }
})

test('DS Bot tool selection has no OpenMausBot aggregate aliases', () => {
  const scope = { allow: ['native:create_bot', 'mcp:agents:create_bot'] }
  assert.equal(allowsTool(scope, native('create_bot')), true)
  assert.equal(allowsTool(scope, mcp('agents', 'create_bot')), true)
  assert.equal(allowsTool(scope, native('update_bot')), false)
  assert.equal(allowsTool(scope, mcp('agents', 'coordinate_bots')), false)
  assert.equal(allowsTool(scope, mcp('agents', 'coordinate_bots'), { action: 'create_bot' }), false)
})

test('parsing de-duplicates and detaches lists without changing explicit empty allow', () => {
  const input = { allow: ['native:read', 'native:read', 'mcp:notes:read'], deny: ['native:write', 'native:write'] }
  const result = parseToolScope(input)
  assert.deepEqual(result, { ok: true, scope: { allow: ['native:read', 'mcp:notes:read'], deny: ['native:write'] } })
  input.allow.push('native:pwsh')
  input.deny.length = 0
  assert.deepEqual(result.scope, { allow: ['native:read', 'mcp:notes:read'], deny: ['native:write'] })
  result.scope.allow.push('native:edit')
  assert.equal(input.allow.includes('native:edit'), false)
  assert.deepEqual(parseToolScope({ allow: [], deny: ['native:pwsh', 'native:pwsh'] }), {
    ok: true, scope: { allow: [], deny: ['native:pwsh'] },
  })
  assert.deepEqual(parseToolScope(Object.assign(Object.create(null), { allow: [] })), { ok: true, scope: { allow: [] } })
  assert.equal(parseToolScope(Object.freeze({ allow: Object.freeze(['native:read']) })).ok, true)
})

test('present malformed scope values never inherit permissions', () => {
  for (const scope of [
    null, false, true, 0, 1, 'all', [], () => ({}), new Date(),
    { allow: '*' }, { allow: undefined }, { deny: null }, { enabled: true },
    { allow: ['native:read', 42] }, { allow: ['read'] }, { allow: ['native:'] },
    { allow: ['native:   '] }, { allow: ['mcp:notes:'] }, { allow: ['mcp:Notes:read'] },
    { allow: ['mcp:1notes:read'] }, { allow: ['mcp:notes.read:read'] },
    { allow: [Object('native:read')] }, { deny: ['mcp:notes:read', undefined] },
    JSON.parse('{"__proto__":{"allow":["native:read"]}}'),
    Object.create({ allow: ['native:read'] }), { [Symbol('allow')]: ['native:read'] },
    Object.defineProperty({}, 'unknown', { value: [] }),
  ]) assertInvalid(scope)
})

test('selector limits and protocol control characters are checked at the boundary', () => {
  const atLimit = `native:${'x'.repeat(1017)}`
  assert.equal(atLimit.length, 1024)
  assert.equal(parseToolScope({ allow: [atLimit] }).ok, true)
  assertInvalid({ allow: [`${atLimit}x`] })
  const list = Array.from({ length: 256 }, (_, index) => `native:tool_${index}`)
  assert.equal(parseToolScope({ allow: list, deny: list }).ok, true)
  assertInvalid({ allow: [...list, 'native:read'] })
  assertInvalid({ deny: Array(257).fill('native:read') })
  assert.equal(parseToolScope({ allow: [`mcp:${'a'.repeat(32)}:read`] }).ok, true)
  assertInvalid({ allow: [`mcp:${'a'.repeat(33)}:read`] })
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    assertInvalid({ allow: [`native:read${String.fromCharCode(code)}`] })
    assertInvalid({ deny: [`mcp:notes:${String.fromCharCode(code)}read`] })
  }
})

test('sparse lists and inherited array elements are rejected', () => {
  assertInvalid({ allow: Array(1) })
  assertInvalid({ deny: ['native:read', ...Array(1)] })
  const inherited = Array(1)
  Object.setPrototypeOf(inherited, { 0: 'native:read' })
  assertInvalid({ allow: inherited })
  const decorated = ['native:read']
  decorated.note = 'ignored?'
  assertInvalid({ allow: decorated })
})

test('scope accessors, element accessors, and custom iterators are never executed', () => {
  let calls = 0
  const getter = () => { calls++; throw new Error('must not execute untrusted getter') }
  for (const key of ['allow', 'deny']) assertInvalid(Object.defineProperty({}, key, { get: getter }))
  const list = ['native:read']
  Object.defineProperty(list, '0', { get: getter })
  assertInvalid({ allow: list })
  assertInvalid({ deny: list })
  const iterable = ['native:read']
  Object.defineProperty(iterable, Symbol.iterator, { get: getter })
  assertInvalid({ allow: iterable })
  assertInvalid({ deny: iterable })
  const changing = ['native:read']
  Object.defineProperty(changing, '0', { get: () => { calls++; return calls === 1 ? 'native:read' : 'native:*' } })
  assertInvalid({ allow: changing })
  assert.equal(calls, 0)
})

test('reflection failures and revoked proxies fail closed without escaping', () => {
  const fail = () => { throw new Error('untrusted reflection failed') }
  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    assertInvalid(new Proxy({ allow: ['native:read'] }, { [trap]: fail }))
  }
  assertInvalid({ allow: new Proxy(['native:read'], { ownKeys: fail }) })
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  assertInvalid(revoked.proxy)
  assertInvalid({ deny: revoked.proxy })
})

test('malformed identities are rejected even when the scope inherits everything', () => {
  for (const tool of [
    undefined, null, 'read', [], {}, { name: 'read' }, { kind: 'other', name: 'read' },
    native(''), native('*'), native('read*'), native('read\n'), native(42),
    mcp('Notes', 'read'), mcp('', 'read'), mcp('*', 'read'), mcp(undefined, 'read'),
    mcp({ toString: () => 'notes' }, 'read'), Object.create(native('read')),
  ]) assert.equal(allowsTool(undefined, tool), false)
  let calls = 0
  const getter = () => { calls++; throw new Error('identity getter must not execute') }
  for (const key of ['kind', 'name', 'server']) {
    const tool = mcp('notes', 'read')
    Object.defineProperty(tool, key, { get: getter })
    assert.equal(allowsTool(undefined, tool), false)
  }
  const revoked = Proxy.revocable(native('read'), {})
  revoked.revoke()
  assert.equal(allowsTool(undefined, revoked.proxy), false)
  assert.equal(calls, 0)
})

test('native narrowing distinguishes an MCP-only restriction', () => {
  for (const scope of [undefined, {}, { deny: [] }, { allow: ['native:*', 'mcp:notes:read'] }, { deny: ['mcp:notes:*'] }]) {
    assert.equal(narrowsNativeTools(scope), false)
  }
  for (const scope of [{ allow: [] }, { allow: ['mcp:notes:read'] }, { deny: ['native:read'] }, { allow: ['native:*'], deny: ['native:pwsh'] }, { allow: 'all' }]) {
    assert.equal(narrowsNativeTools(scope), true)
  }
})

test('MCP server eligibility respects allow, deny, and the available catalog', () => {
  assert.equal(canUseMcpServer(undefined, 'notes'), true)
  assert.equal(canUseMcpServer({ allow: [] }, 'notes'), false)
  assert.equal(canUseMcpServer({ allow: ['native:read'] }, 'notes'), false)
  assert.equal(canUseMcpServer({ allow: ['mcp:other:read'] }, 'notes'), false)
  assert.equal(canUseMcpServer({ allow: ['mcp:notes:read'], deny: ['mcp:notes:read'] }, 'notes'), false)
  assert.equal(canUseMcpServer({ allow: ['mcp:notes:*'], deny: ['mcp:notes:read'] }, 'notes'), true)
  assert.equal(canUseMcpServer({ deny: ['mcp:notes:*'] }, 'notes'), false)
  assert.equal(canUseMcpServer({ allow: ['mcp:notes:unknown'] }, 'notes', ['read', 'write']), false)
  assert.equal(canUseMcpServer({ allow: ['mcp:notes:read'] }, 'notes', ['read', 'write']), true)
  assert.equal(canUseMcpServer({ allow: ['mcp:notes:*'], deny: ['mcp:notes:read'] }, 'notes', ['read']), false)
  assert.equal(canUseMcpServer(undefined, 'notes', []), false)
  assert.equal(canUseMcpServer(undefined, 'notes', Array.from({ length: 300 }, (_, index) => `tool_${index}`)), true)
})

test('bad MCP server catalogs fail closed and never invoke getters or coerce servers', () => {
  let calls = 0
  const getter = () => { calls++; throw new Error('must not execute') }
  for (const server of [undefined, null, 42, '', 'Notes', 'a'.repeat(33), { toString: getter }]) {
    assert.equal(canUseMcpServer(undefined, server), false)
  }
  for (const names of [null, 'read', {}, Array(1), ['read', undefined], ['read', '*'], ['read', 'bad\n']]) {
    assert.equal(canUseMcpServer(undefined, 'notes', names), false)
  }
  const list = ['read', 'write']
  Object.defineProperty(list, '1', { get: getter })
  assert.equal(canUseMcpServer(undefined, 'notes', list), false)
  const iterable = ['read']
  Object.defineProperty(iterable, Symbol.iterator, { get: getter })
  assert.equal(canUseMcpServer(undefined, 'notes', iterable), false)
  const revoked = Proxy.revocable([], {})
  revoked.revoke()
  assert.equal(canUseMcpServer(undefined, 'notes', revoked.proxy), false)
  assert.equal(calls, 0)
})

test('widening detects added authority while preserving equivalent and narrower selections', () => {
  const cases = [
    [{ allow: ['native:read'] }, { allow: ['native:edit', 'native:read'] }, true],
    [{ allow: ['native:*'] }, { allow: ['native:read'] }, false],
    [{ allow: ['native:read', 'native:edit'] }, { allow: ['native:edit', 'native:read', 'native:read'] }, false],
    [{ allow: ['mcp:notes:read'] }, { allow: ['mcp:notes:*'] }, true],
    [{ allow: ['mcp:notes:*'] }, { allow: ['mcp:notes:read'] }, false],
    [{ deny: ['mcp:notes:*'] }, { deny: ['mcp:notes:write'] }, true],
    [undefined, { deny: ['native:pwsh'] }, false],
    [{ allow: ['native:read'] }, undefined, true],
    [{ allow: null }, { allow: [] }, false],
    [{ allow: null }, { allow: ['native:read'] }, true],
    [{ allow: null }, undefined, true],
    [undefined, { allow: null }, false],
    [{ allow: null }, { deny: null }, false],
    [{ allow: ['native:read'] }, { allow: ['mcp:notes:read'] }, true],
    [{ allow: ['native:read'] }, { allow: ['native:read', 'native:write'], deny: ['native:write'] }, false],
    [{ allow: ['native:read'], deny: ['native:read'] }, { allow: [] }, false],
    [{ allow: ['native:*'], deny: ['native:write'] }, { allow: ['native:*'] }, true],
    [{ allow: ['native:*'] }, { allow: ['native:*'], deny: ['native:write'] }, false],
    [{ allow: [] }, { allow: ['native:*'], deny: ['native:*'] }, false],
    [undefined, {}, false], [{}, undefined, false],
  ]
  for (const [previous, next, expected] of cases) {
    assert.equal(toolScopeWidens(previous, next), expected, JSON.stringify({ previous, next }))
  }
})

test('widening tests unseen tools and servers even when sentinel names are already selected', () => {
  const exact = { allow: ['native:__unlisted_tool__', 'native:__unlisted_tool_0__'] }
  assert.equal(toolScopeWidens(exact, { allow: ['native:*'] }), true)
  const selectedServers = { allow: ['native:*', 'mcp:unlisted:*', 'mcp:unlisted0:*', 'mcp:notes:*'] }
  assert.equal(toolScopeWidens(selectedServers, undefined), true)
  assert.equal(toolScopeWidens(undefined, selectedServers), false)
  const disabled = { deny: ['native:*', 'mcp:unlisted:*', 'mcp:unlisted0:*', 'mcp:notes:*'] }
  assert.equal(toolScopeWidens({ allow: [] }, disabled), true)
})

test('DSH names map to exact native or MCP identities without normalization', () => {
  for (const name of ['read', 'pwsh', 'message_bot', 'create_bot', 'run_code', 'cua_driver_native__click', 'MixedCase', 'native-tool']) {
    assert.deepEqual(dshToolIdentity(name), native(name))
  }
  for (const [name, server, tool] of [
    ['mcp__github__search_issues', 'github', 'search_issues'],
    ['mcp__mslearn__microsoft_docs_search', 'mslearn', 'microsoft_docs_search'],
    ['mcp__my-tools__read-notes', 'my-tools', 'read-notes'],
    ['mcp__my_tools__ReadNotes', 'my_tools', 'ReadNotes'],
  ]) assert.deepEqual(dshToolIdentity(name), mcp(server, tool))
  const atLimit = `mcp__notes__${'r'.repeat(52)}`
  assert.equal(atLimit.length, 64)
  assert.deepEqual(dshToolIdentity(atLimit), mcp('notes', 'r'.repeat(52)))
})

test('ambiguous, lossy, and malformed DSH public names never fall back to native', () => {
  let calls = 0
  const coercible = { toString: () => { calls++; return 'read' } }
  for (const name of [
    undefined, null, 42, coercible, '', '*', 'read*', ' read', 'read ', 'read\n', 'read\0', 'read\u007f', 'native:read', 'read.file', 'r'.repeat(65),
    'mcp__', 'mcp__notes', 'mcp__notes__', 'mcp____read', 'mcp__Notes__read', 'mcp__1notes__read',
    'mcp__notes___read', 'mcp__notes__read__file', 'mcp__my__notes__read', 'mcp__notes__*',
    'mcp__notes__namespace:read', 'mcp__notes__read_file_0123456789ab',
    `mcp__${'a'.repeat(33)}__read`, `mcp__notes__${'r'.repeat(53)}`,
  ]) {
    assert.equal(dshToolIdentity(name), undefined)
    assert.equal(allowsTool(undefined, dshToolIdentity(name)), false)
    assert.equal(allowsTool({ allow: ['native:*', 'mcp:notes:*'] }, dshToolIdentity(name)), false)
  }
  assert.equal(calls, 0)
})

test('DSH-adapted tool decisions enforce server and native boundaries with deny first', () => {
  const scope = {
    allow: ['native:read', 'native:message_bot', 'mcp:github:*'],
    deny: ['mcp:github:create_issue'],
  }
  for (const [name, expected] of [
    ['read', true], ['message_bot', true], ['write', false],
    ['mcp__github__search_issues', true], ['mcp__github__create_issue', false],
    ['mcp__other__search_issues', false], ['mcp__github__read', true],
    ['mcp__notes__read', false], ['mcp__github__create_issue_0123456789ab', false],
  ]) assert.equal(allowsTool(scope, dshToolIdentity(name)), expected, name)
})
