import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/runtime-controls.js'

function bench() {
  const bots = {
    writer: { id: 'writer', name: 'Writer', model: 'magpie-writer/codex/model', modelFallback: false, toolScope: { allow: ['native:read', 'mcp:github:*'], deny: ['mcp:github:delete'] } },
    builder: { id: 'builder', name: 'Builder', model: 'magpie-builder/codex/model', modelFallback: false, toolScope: { allow: ['native:write'] } },
    legacy: { id: 'legacy', name: 'Legacy' },
  }
  const owners = { writer: 'writer', 'writer-part-2': 'writer', 'writer-in-group': 'writer', builder: 'builder', legacy: 'legacy' }
  let guard, hook
  const received = []
  const terminal = async function* (options) { received.push(options); await options.wait; yield { type: 'finish', reason: { kind: 'stop' } } }
  const ctx = {
    tools: { guard: fn => { guard = fn } },
    on: (name, fn) => { assert.equal(name, 'llm/stream'); hook = fn },
    llm: { stream: options => hook(options, () => terminal(options)) },
  }
  const rt = {
    ctx, load: async () => {}, selfOf: id => owners[id], botOf: id => bots[id],
    desiredModel: async bot => bot.model, isLocalAgentRoute: provider => provider === 'codex-cli',
  }
  install(rt)
  const stream = async (sessionId, patch = {}) => {
    const bot = bots[owners[sessionId]]
    const provider = bot?.model?.split('/')[0] ?? 'default'
    const options = { sessionId, provider, model: 'codex/model', tools: ['read', 'write', 'mcp__github__list', 'mcp__github__delete'].map(name => ({ name })), messages: [], ...patch }
    for await (const chunk of ctx.llm.stream(Object.freeze(options))) assert.equal(chunk.type, 'finish')
    return options
  }
  const execute = (sessionId, name) => guard({ name, agent: { session: { id: sessionId } } })
  return { bots, received, stream, execute, rt }
}

test('owner policy checks do not replace prepared requests or change their tool history', async () => {
  const { stream, received, execute } = bench()
  const toolHistory = Object.freeze([{ seq: 1, added: ['read', 'write'] }])
  for (const session of ['writer', 'builder', 'writer-in-group', 'writer-part-2']) {
    const original = await stream(session, { toolHistory })
    assert.equal(received.at(-1), original)
    assert.equal(received.at(-1).toolHistory, toolHistory)
    assert.equal(original.tools.length, 4)
    if (session === 'builder') assert.match(execute(session, 'read'), /disabled/)
    else assert.match(execute(session, 'write'), /disabled/)
  }
  assert.deepEqual(received.map(options => options.provider), ['magpie-writer', 'magpie-builder', 'magpie-writer', 'magpie-writer'])
})

test('execution guard rechecks stale and forwarded calls after a policy change', async () => {
  const { bots, stream, execute } = bench()
  await stream('writer')
  assert.equal(execute('writer', 'read'), undefined)
  assert.match(execute('writer-in-group', 'write'), /disabled/)
  assert.match(execute('writer', 'mcp__github__delete'), /disabled/)
  bots.writer.toolScope = { allow: [] }
  assert.match(execute('writer-part-2', 'read'), /disabled/)
  assert.match(execute('builder', 'read'), /disabled/)
  assert.equal(execute('builder', 'write'), undefined)
})

test('fixed connection rejects stale Session model without making an upstream call', async () => {
  const { stream, received, rt } = bench()
  await assert.rejects(stream('writer-in-group', { provider: 'magpie-builder' }), /connection.*fixed/)
  assert.equal(received.length, 0)
  rt.desiredModel = async () => { throw new Error('connection unavailable') }
  await assert.rejects(stream('writer'), /unavailable/)
  assert.equal(received.length, 0)
})

test('auxiliary title calls keep Harness model policy while conversational calls remain pinned', async () => {
  const { stream, received } = bench()
  await stream('writer', { purpose: 'title', provider: 'title-provider' })
  assert.equal(received[0].provider, 'title-provider')
  await assert.rejects(stream('writer', { provider: 'title-provider' }), /fixed/)
})

test('an invalid saved scope fails closed for model requests and execution', async () => {
  const { bots, stream, execute, received } = bench()
  bots.writer.toolScope = { allow: 'all' }
  await assert.rejects(stream('writer'), /Tool access.*invalid/)
  assert.match(execute('writer', 'read'), /disabled/)
  assert.equal(received.length, 0)
})

test('local agent engines cannot bypass a DSH tool selection', async () => {
  const { bots, stream, received } = bench()
  bots.writer.model = 'codex-cli/codex/model'
  await assert.rejects(stream('writer'), /Local agents have their own tools/)
  assert.equal(received.length, 0)
})

test('active CLI calls stay tracked across a model switch until their streams settle', async () => {
  const { bots, stream, rt, received } = bench()
  bots.writer.model = 'codex-cli/codex/model'
  delete bots.writer.toolScope
  let release
  const wait = new Promise(resolve => { release = resolve })
  const first = stream('writer', { wait })
  const second = stream('writer-in-group', { wait })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(received.length, 2)
  assert.equal(rt.hasActiveLocalAgentCalls('writer'), true)
  bots.writer.model = 'magpie-writer/codex/model'
  assert.equal(rt.hasActiveLocalAgentCalls('writer'), true)
  release()
  await Promise.all([first, second])
  assert.equal(rt.hasActiveLocalAgentCalls('writer'), false)
})

test('unscoped Bots and ordinary DSH Sessions keep their original tool catalog', async () => {
  const { stream, execute, received } = bench()
  await stream('legacy')
  await stream('ordinary')
  assert.equal(received.length, 2)
  assert.equal(received.every(options => options.tools.length === 4), true)
  assert.equal(execute('ordinary', 'write'), undefined)
  assert.equal(execute('legacy', 'mcp__ambiguous__raw__name'), undefined)
})

test('PTC transport keeps permitted SDK calls reachable and checks every nested tool', async () => {
  const { bots, stream, received, execute } = bench()
  const tools = [{ name: 'run_code', description: 'Tool SDK transport' }]
  await stream('writer', { tools })
  assert.deepEqual(received[0].tools, tools)
  assert.equal(execute('writer', 'run_code'), undefined)
  assert.equal(execute('writer', 'read'), undefined)
  assert.match(execute('writer', 'write'), /disabled/)
  bots.writer.toolScope = { allow: ['mcp:github:*'], deny: ['native:*'] }
  assert.equal(execute('writer', 'run_code'), undefined)
  assert.equal(execute('writer', 'mcp__github__list'), undefined)
  assert.match(execute('writer', 'read'), /disabled/)
  bots.writer.toolScope = { allow: [] }
  assert.match(execute('writer', 'run_code'), /disabled/)
  bots.writer.toolScope = { deny: ['native:run_code'] }
  assert.match(execute('writer', 'run_code'), /disabled/)
})

test('ambiguous MCP names are unavailable under an explicit scope', () => {
  const { bots, execute } = bench()
  bots.writer.toolScope = { allow: ['mcp:github:*'] }
  assert.match(execute('writer', 'mcp__github__raw__name'), /disabled/)
})
