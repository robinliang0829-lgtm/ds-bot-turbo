// Real DSH runtime + pi-ai HTTP/SSE transport, with only settings/credentials and
// the upstream server in memory. No DSH profile, real gateway, or model key is used.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmRuntime, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { install as installProviders } from '../src/host/providers.js'

const MODEL = 'codex/gpt-6-astra'
const TOOL = {
  name: 'lookup_weather', description: 'Read a synthetic weather report',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
}
const ARGUMENTS = '{"city":"Hangzhou"}'
const TOOL_RESULT = 'Synthetic weather: sunny, 23 C.'
const PROTOCOLS = [
  { api: 'openai-responses', path: '/v1/responses', key: 'synthetic-magpie-responses-key', label: 'responses' },
  { api: 'openai-completions', path: '/v1/chat/completions', key: 'synthetic-magpie-completions-key', label: 'completions' },
]

function responseEvents(label, answered) {
  const text = answered ? `${label}: ${TOOL_RESULT}` : `${label}: checking weather.`
  const message = {
    id: `msg_${label}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const call = {
    id: `fc_${label}`, call_id: `call_${label}`, type: 'function_call',
    status: 'completed', name: TOOL.name, arguments: ARGUMENTS,
  }
  const response = { id: `resp_${label}`, object: 'response', created_at: 1, model: MODEL, error: null }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: message.id, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: text.slice(0, 10) },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: text.slice(10) },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: message.id, text },
    { type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: message.id, part: message.content[0] },
    { type: 'response.output_item.done', output_index: 0, item: message },
  ]
  if (!answered) events.push(
    { type: 'response.output_item.added', output_index: 1, item: { ...call, status: 'in_progress', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: call.id, delta: ARGUMENTS.slice(0, 9) },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: call.id, delta: ARGUMENTS.slice(9) },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: call.id, arguments: ARGUMENTS },
    { type: 'response.output_item.done', output_index: 1, item: call },
  )
  events.push({
    type: 'response.completed',
    response: {
      ...response, status: 'completed', output: answered ? [message] : [message, call],
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    },
  })
  return events.map((event, sequence_number) => ({ ...event, sequence_number }))
}

function completionEvents(label, answered) {
  const text = answered ? `${label}: ${TOOL_RESULT}` : `${label}: checking weather.`
  const chunk = (delta, finish_reason = null) => ({
    id: `chatcmpl_${label}`, object: 'chat.completion.chunk', created: 1, model: MODEL,
    choices: [{ index: 0, delta, finish_reason }],
  })
  const events = [chunk({ role: 'assistant', content: text.slice(0, 10) }), chunk({ content: text.slice(10) })]
  if (!answered) events.push(
    chunk({ tool_calls: [{ index: 0, id: `call_${label}`, type: 'function', function: { name: TOOL.name, arguments: ARGUMENTS.slice(0, 9) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ARGUMENTS.slice(9) } }] }),
  )
  events.push(chunk({}, answered ? 'stop' : 'tool_calls'))
  events.push({
    id: `chatcmpl_${label}`, object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  })
  return events
}

async function mockGateway(t, protocol) {
  const requests = []
  const server = createServer((req, res) => {
    void (async () => {
      let raw = ''
      for await (const chunk of req) raw += chunk.toString()
      const body = raw ? JSON.parse(raw) : undefined
      requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body })
      if (req.headers.authorization !== `Bearer ${protocol.key}`) {
        res.writeHead(401).end('Unexpected synthetic credential')
        return
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{
          id: MODEL, display_name: 'Synthetic Codex', context_window: 128000, max_output_tokens: 4096,
          modalities: { input: ['text'] }, native_endpoints: [protocol.api === 'openai-responses' ? 'responses' : 'chat/completions'],
        }] }))
        return
      }
      if (req.method !== 'POST' || req.url !== protocol.path || body?.model !== MODEL) {
        res.writeHead(400).end('Unexpected model route')
        return
      }
      const answered = protocol.api === 'openai-responses'
        ? body.input?.some(item => item.type === 'function_call_output')
        : body.messages?.some(item => item.role === 'tool')
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' })
      const events = protocol.api === 'openai-responses'
        ? responseEvents(protocol.label, answered)
        : completionEvents(protocol.label, answered)
      for (const event of events) {
        const eventName = protocol.api === 'openai-responses' ? `event: ${event.type}\n` : ''
        res.write(`${eventName}data: ${JSON.stringify(event)}\n\n`)
      }
      if (protocol.api === 'openai-completions') res.write('data: [DONE]\n\n')
      res.end()
    })().catch(() => { res.writeHead(500).end('Synthetic gateway failed') })
  })
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { ...protocol, baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

async function setup(t) {
  const gateways = await Promise.all(PROTOCOLS.map(protocol => mockGateway(t, protocol)))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const keys = new Map()
  const credentials = {
    describe: async ref => ({ configured: keys.has(ref), writable: true }),
    set: async (ref, value) => { keys.set(ref, value) },
    resolve: async ref => keys.has(ref) ? { value: keys.get(ref), source: 'memory-test' } : undefined,
    readRecord: async () => undefined,
    listRecords: async () => [],
  }
  ctx.provide('credentials', credentials)
  await ctx.plugin(LlmRuntime)
  const profiles = {}
  let revision = 0
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision, value: { providers: profiles }, user: { providers: profiles }, base: {} }],
    mutate: async (ns, ops, expected) => {
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(expected, revision)
      for (const op of ops) {
        assert.equal(op.op, 'set')
        assert.equal(op.path[0], 'providers')
        assert.equal(op.path.length, 2)
        profiles[op.path[1]] = structuredClone(op.value)
      }
      revision += 1
    },
  }
  // The production connection path writes its actual profile into a memory settings seam.
  // Mount those saved profiles via the public plugin API, without private resolvers.
  const rt = {
    ctx: { llm: ctx.llm, get: name => ({ settings, credentials })[name] },
    catalog: async () => [], dropCatalog: () => {},
  }
  installProviders(rt)
  for (const gateway of gateways) {
    const draft = { preset: 'magpie', api: gateway.api, baseURL: gateway.baseURL, key: gateway.key }
    const models = await rt.discoverModels(draft)
    assert.deepEqual(models.map(model => model.id), [MODEL])
    await rt.addProvider({ ...draft, name: `Mock ${gateway.label}`, models })
    gateway.provider = Object.keys(profiles).at(-1)
    gateway.profile = profiles[gateway.provider]
  }
  await ctx.plugin(PiAi, { providers: profiles })
  assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), gateways.map(gateway => gateway.provider))
  return { ctx, keys, gateways }
}

async function collect(llm, options) {
  const assembler = new BlockAssembler()
  const chunks = []
  for await (const chunk of llm.stream({ ...options, signal: AbortSignal.timeout(10_000) })) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  return { assembler, chunks, finish: assembler.finish }
}

async function roundTrip(llm, gateway) {
  const user = createUserMessage({ content: [{ type: 'text', text: 'Check the synthetic Hangzhou weather.' }], source: { kind: 'user' } })
  const options = { provider: gateway.provider, model: MODEL, messages: [user], tools: [TOOL], maxTokens: 128 }
  const first = await collect(llm, options)
  assert.equal(first.finish.kind, 'tool-calls', JSON.stringify(first.finish))
  const assistant = first.assembler.message({ provider: gateway.provider, model: MODEL, replayState: first.assembler.replayState })
  const calls = assistant.content.filter(block => block.type === 'tool-call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, TOOL.name)
  assert.deepEqual(JSON.parse(calls[0].arguments), JSON.parse(ARGUMENTS))
  assert.ok(first.chunks.filter(chunk => chunk.type === 'text-delta').length >= 2)
  assert.ok(first.chunks.some(chunk => chunk.type === 'tool-call-delta'))
  const result = createToolResultMessage({ callId: calls[0].id, content: [{ type: 'text', text: TOOL_RESULT }], isError: false })
  const second = await collect(llm, { ...options, messages: [user, assistant, result] })
  assert.equal(second.finish.kind, 'stop', JSON.stringify(second.finish))
  assert.equal(second.assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join(''), `${gateway.label}: ${TOOL_RESULT}`)
  assert.equal(second.assembler.usage?.inputTokens, 20)
  assert.equal(second.assembler.usage?.outputTokens, 8)
}

test('Magpie connections discover, save, and stream both protocols through real DSH with independent endpoints and keys', { timeout: 30000 }, async (t) => {
  const { ctx, gateways } = await setup(t)
  assert.notEqual(gateways[0].baseURL, gateways[1].baseURL)
  assert.notEqual(gateways[0].provider, gateways[1].provider)
  assert.notEqual(gateways[0].profile.apiKeyEnv, gateways[1].profile.apiKeyEnv)
  await Promise.all(gateways.map(gateway => roundTrip(ctx.llm, gateway)))
  for (const gateway of gateways) {
    assert.equal(gateway.requests.length, 3)
    assert.equal(gateway.requests[0].method, 'GET')
    for (const request of gateway.requests) assert.equal(request.authorization, `Bearer ${gateway.key}`)
    const posts = gateway.requests.filter(request => request.method === 'POST')
    assert.equal(posts.length, 2)
    for (const { path, body } of posts) {
      assert.equal(path, gateway.path)
      assert.equal(body.model, MODEL)
      assert.equal(body.stream, true)
    }
    if (gateway.api === 'openai-responses') {
      assert.equal(posts[0].body.tools[0].name, TOOL.name)
      const replayed = posts[1].body.input.find(item => item.type === 'function_call')
      const returned = posts[1].body.input.find(item => item.type === 'function_call_output')
      assert.equal(replayed.name, TOOL.name)
      assert.equal(replayed.arguments, ARGUMENTS)
      assert.equal(returned.call_id, replayed.call_id)
      assert.equal(returned.call_id, `call_${gateway.label}`)
      assert.equal(returned.output, TOOL_RESULT)
    } else {
      assert.equal(posts[0].body.tools[0].function.name, TOOL.name)
      const replayed = posts[1].body.messages.find(message => message.role === 'assistant').tool_calls[0]
      const returned = posts[1].body.messages.find(message => message.role === 'tool')
      assert.equal(replayed.function.name, TOOL.name)
      assert.equal(replayed.function.arguments, ARGUMENTS)
      assert.equal(returned.tool_call_id, replayed.id)
      assert.equal(returned.tool_call_id, `call_${gateway.label}`)
      assert.equal(returned.content, TOOL_RESULT)
    }
  }
})

test('a missing Magpie route credential fails before HTTP without borrowing the other connection key', { timeout: 30000 }, async (t) => {
  const { ctx, keys, gateways } = await setup(t)
  const [missing, working] = gateways
  keys.delete(missing.profile.apiKeyEnv)
  const failed = await collect(ctx.llm, { provider: missing.provider, model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'No credential' }] }] })
  assert.equal(failed.finish.kind, 'error')
  assert.equal(failed.finish.failure.code, 'MISSING_CREDENTIAL')
  assert.equal(missing.requests.length, 1)
  assert.ok(!JSON.stringify(failed.finish).includes(working.key))
  await roundTrip(ctx.llm, working)
  assert.equal(missing.requests.length, 1)
  assert.equal(working.requests.length, 3)
})
