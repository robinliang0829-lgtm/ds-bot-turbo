import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { install as installModels } from '../src/host/models.js'
import { checkKey, install, keyRefFor } from '../src/host/providers.js'
import { MAGPIE, MAGPIE_LOCAL_KEY, magpieModels } from '../src/shared/magpie.js'

// A DSH with the official DeepSeek route, an account route, and the pi-ai adapter: its
// directory offers catalog providers, and its settings take path writes the way DSH's
// do, under a revision. Routes come and go with the pi-ai section.
function dsh({ keys = {}, readOnly = [], user = {}, base = {}, catalog = { anthropic: ['claude-a', 'claude-b'], moonshotai: ['kimi-k3'] } } = {}) {
  const store = { ...keys }
  const writes = []
  const listeners = new Map()
  let revision = 0
  let pi = { user: structuredClone(user), base: structuredClone(base) }
  const piValue = () => ({ providers: { ...pi.base.providers, ...pi.user.providers } })
  const routes = () => Object.keys(piValue().providers)
  const services = {
    settings: {
      describe: () => [
        { ns: 'llm-deepseek', revision: 0, value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user: {}, base: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
        { ns: 'llm-deepseek-account', revision: 0, value: {}, user: {}, base: {} },
        { ns: 'llm-pi-ai', revision, value: piValue(), user: structuredClone(pi.user), base: structuredClone(pi.base) },
      ],
      mutate: async (ns, ops, expected) => {
        if (expected !== revision) throw new Error(`settings namespace "${ns}" changed since it was read`)
        const next = structuredClone(pi.user)
        for (const op of ops) {
          const parent = op.path.slice(0, -1).reduce((value, key) => (value[key] ??= {}), next)
          if (op.op === 'set') parent[op.path.at(-1)] = op.value
          else delete parent[op.path.at(-1)]
        }
        for (const [id, profile] of Object.entries(next.providers ?? {})) {
          if (!(id in catalog) && !(profile.models?.length > 0)) throw new Error(`llm-pi-ai: provider "${id}" resolves no models`)
        }
        writes.push([ns, ops])
        pi = { ...pi, user: next }
        revision += 1
      },
    },
    credentials: {
      describe: async ref => ({ configured: ref in store, writable: !readOnly.includes(ref) }),
      set: async (ref, value) => { writes.push(['set', ref]); store[ref] = value },
      unset: async (ref) => { writes.push(['unset', ref]); delete store[ref] },
    },
  }
  const discovered = []
  const ctx = {
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    get: name => services[name],
    llm: {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'deepseek-account', name: 'DeepSeek Account' }, ...routes().map(id => ({ id, name: piValue().providers[id].displayName ?? id }))],
      listModels: async (id) => {
        if (id === 'deepseek-official') return [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }]
        if (id === 'deepseek-account') return []
        const profile = piValue().providers[id]
        return profile.models ?? (catalog[id] ?? []).map(model => ({ id: model }))
      },
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
        { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
        ...Object.keys(catalog).map(id => ({ provider: id, displayName: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id], declared: false })),
        ...routes().filter(id => !(id in catalog)).map(id => ({ provider: id, displayName: piValue().providers[id].displayName ?? id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id], declared: true })),
      ],
      discoverModels: async (ns, request) => { discovered.push([ns, request]); return [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, inputModalities: ['text'] }, { id: 'relay-2' }] },
    },
  }
  const rt = { ctx, state: { bots: {} } }
  installModels(rt)
  install(rt)
  return { rt, store, writes, listeners, discovered }
}

const needing = async rt => (await rt.catalog({ fresh: true })).filter(entry => entry.needsKey).map(entry => entry.provider)
const row = (view, id) => view.providers.find(provider => provider.id === id)

test('models of a provider whose API key is set nowhere need the key', async () => {
  const user = { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' }, bedrock: {} } }
  const catalog = { moonshotai: ['kimi-k3'], bedrock: ['nova'] }
  assert.deepEqual(await needing(dsh({ user, catalog }).rt), ['deepseek-official', 'moonshotai'])
  assert.deepEqual(await needing(dsh({ user, catalog, keys: { DEEPSEEK_API_KEY: 'k' } }).rt), ['moonshotai'])
  // A route without a key reference authenticates some other way.
  assert.ok((await dsh({ user, catalog }).rt.catalog()).some(entry => entry.provider === 'bedrock' && !entry.needsKey))
})

test('without DSH settings or credentials no model needs a key, and there is no Models page', async () => {
  const { rt } = dsh()
  rt.ctx.get = () => undefined
  assert.deepEqual(await needing(rt), [])
  assert.deepEqual(await rt.providersView(), { available: false })
})

test('the page lists the providers set up and the ones DSH can add', async () => {
  const { rt } = dsh({ keys: { DEEPSEEK_API_KEY: 'k' }, user: { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } } } })
  const view = await rt.providersView()
  assert.deepEqual(view.providers.map(provider => [provider.id, provider.key, provider.removable, provider.models.length]), [
    ['deepseek-official', { configured: true, writable: true }, false, 1],
    ['moonshotai', { configured: false, writable: true }, true, 1],
  ])
  // The account route has no key and no models before a sign-in.
  assert.equal(row(view, 'deepseek-account'), undefined)
  assert.deepEqual(view.addable, [{ id: 'anthropic', name: 'anthropic' }])
  assert.deepEqual(view.protocols, ['openai-completions', 'openai-responses', 'anthropic-messages'])
})

test('a saved API key goes to the provider\'s reference and frees its models', async () => {
  const { rt, store, writes } = dsh()
  await rt.setProviderKey('deepseek-official', '  sk-test  ')
  assert.deepEqual(writes, [['set', 'DEEPSEEK_API_KEY']])
  assert.equal(store.DEEPSEEK_API_KEY, 'sk-test')
  assert.deepEqual(await needing(rt), [])
  await rt.clearProviderKey('deepseek-official')
  assert.equal('DEEPSEEK_API_KEY' in store, false)
  await assert.rejects(rt.setProviderKey('deepseek-account', 'sk-test'), /deepseek-account takes no API key here/)
})

test('a key set outside DS Bot is not overwritten or removed', async () => {
  const { rt, writes } = dsh({ keys: { DEEPSEEK_API_KEY: 'k' }, readOnly: ['DEEPSEEK_API_KEY'] })
  await assert.rejects(rt.setProviderKey('deepseek-official', 'sk-test'), /set outside DS Bot/)
  await assert.rejects(rt.clearProviderKey('deepseek-official'), /set outside DS Bot/)
  assert.deepEqual(writes, [])
  assert.deepEqual(row(await rt.providersView(), 'deepseek-official').key, { configured: true, writable: false })
})

test('a provider from DSH\'s list goes in with the key DSH\'s own page would name', async () => {
  const { rt, store, writes } = dsh()
  const view = await rt.addProvider({ provider: 'moonshotai', key: 'sk-kimi' })
  assert.deepEqual(writes, [['llm-pi-ai', [{ op: 'set', path: ['providers', 'moonshotai'], value: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } }]], ['set', 'MOONSHOTAI_API_KEY']])
  assert.equal(store.MOONSHOTAI_API_KEY, 'sk-kimi')
  assert.deepEqual(row(view, 'moonshotai').models.map(model => model.ref), ['moonshotai/kimi-k3'])
  assert.equal(view.addable.some(entry => entry.id === 'moonshotai'), false)
  await assert.rejects(rt.addProvider({ provider: 'moonshotai', key: 'sk-kimi' }), /moonshotai is already set up/)
  await assert.rejects(rt.addProvider({ provider: 'deepseek-official' }), /already set up/)
  await assert.rejects(rt.addProvider({ provider: 'nowhere' }), /DSH offers no provider nowhere/)
})

test('a blank key keeps a key that is already there, else leaves the route without one', async () => {
  const { rt, writes } = dsh({ keys: { ANTHROPIC_API_KEY: 'k' } })
  await rt.addProvider({ provider: 'anthropic', key: '' })
  await rt.addProvider({ provider: 'moonshotai' })
  assert.deepEqual(writes.map(([, ops]) => ops[0].value), [{ apiKeyEnv: 'ANTHROPIC_API_KEY' }, {}])
})

test('a custom API goes in with its endpoint, protocol, compatibility switches and the models picked', async () => {
  const { rt, store, writes } = dsh()
  await rt.addProvider({
    custom: true, provider: 'relay', name: ' My relay ', api: 'openai-completions', baseURL: ' https://relay.example/v1 ', key: 'sk-relay',
    models: [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, inputModalities: ['text'] }, 'relay-2'],
  })
  assert.deepEqual(writes[0], ['llm-pi-ai', [{ op: 'set', path: ['providers', 'relay'], value: {
    displayName: 'My relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_API_KEY',
    compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true },
    models: [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, input: ['text'] }, { id: 'relay-2' }],
  } }]])
  assert.equal(store.RELAY_API_KEY, 'sk-relay')
  const view = await rt.providersView()
  assert.deepEqual([row(view, 'relay').name, row(view, 'relay').custom, row(view, 'relay').removable], ['My relay', true, true])
  // OpenAI Responses takes supportsDeveloperRole alone; Anthropic Messages takes no OpenAI compat switch.
  await rt.addProvider({ custom: true, provider: 'resp-gw', api: 'openai-responses', baseURL: 'https://resp.example/v1', models: ['m'] })
  assert.deepEqual(writes.at(-1)[1][0].value.compat, { supportsDeveloperRole: false })
  await rt.addProvider({ custom: true, provider: 'anth-gw', api: 'anthropic-messages', baseURL: 'https://anth.example', models: ['m'] })
  assert.equal(writes.at(-1)[1][0].value.compat, undefined)
})

test('existing custom routes and custom-endpoint catalog routes backfill missing compatibility switches without overwriting explicit ones', async () => {
  const user = {
    providers: {
      moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' },
      openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://gateway.example/v1', models: [{ id: 'k3.1-pro' }] },
      relay: { api: 'openai-completions', baseURL: 'https://gateway.example/v1', compat: { supportsStore: true }, models: [{ id: 'k3.1-pro' }] },
    },
  }
  const { rt, writes } = dsh({ user, catalog: { moonshotai: ['kimi-k3'], openai: ['gpt-5'] } })
  await rt.providersView()
  assert.deepEqual(writes, [['llm-pi-ai', [
    { op: 'set', path: ['providers', 'openai', 'compat'], value: { supportsDeveloperRole: false } },
    { op: 'set', path: ['providers', 'relay', 'compat'], value: { supportsDeveloperRole: false, supportsStore: true, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true } },
  ]]])
  // A second read sees every switch in place and writes nothing again.
  writes.length = 0
  await rt.providersView()
  assert.deepEqual(writes, [])
})

test('a custom gateway model whose id matches a built-in catalog model inherits its context window and image support when the endpoint omits them', async () => {
  const { rt, writes } = dsh({ catalog: { 'kimi-coding': ['k3.1-pro'] } })
  const origList = rt.ctx.llm.listConfigurableProviders
  rt.ctx.llm.listConfigurableProviders = () => origList().map(entry => (entry.provider === 'kimi-coding' ? { ...entry, defaultBaseURL: 'https://api.kimi.com/coding/v1' } : entry))
  rt.ctx.llm.discoverModels = async (_ns, request) => {
    if (request.provider === 'kimi-coding') {
      return [{ id: 'k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1048576, maxTokens: 131072, inputModalities: ['text', 'image'] }]
    }
    return [{ id: 'k3.1-pro', name: 'k3.1-pro' }, { id: 'custom-only', name: 'custom-only' }]
  }
  const discovered = await rt.discoverModels({ baseURL: 'https://gateway.example/v1', api: 'openai-completions', key: 'sk-gw' })
  assert.deepEqual(discovered, [
    { id: 'k3.1-pro', name: 'k3.1-pro', contextWindow: 1048576, inputModalities: ['text', 'image'] },
    { id: 'custom-only', name: 'custom-only' },
  ])
  await rt.addProvider({ custom: true, provider: 'my-gateway', api: 'openai-completions', baseURL: 'https://gateway.example/v1', models: ['moonshotai/k3.1-pro'] })
  assert.deepEqual(writes[0][1][0].value.models, [
    { id: 'moonshotai/k3.1-pro', contextWindow: 1048576, input: ['text', 'image'] },
  ])
  // Verify the written profile against the real dsh-llm-pi-ai schema.
  const validated = PiAiConfig({ providers: { 'my-gateway': writes[0][1][0].value } }).providers.get()['my-gateway']
  assert.equal(validated.models[0].id, 'moonshotai/k3.1-pro')
  assert.equal(validated.models[0].contextWindow, 1048576)
  assert.deepEqual(validated.models[0].input, ['text', 'image'])
  assert.equal(validated.compat.supportsDeveloperRole, false)
  assert.equal(validated.compat.supportsStore, false)
  assert.equal(validated.compat.maxTokensField, 'max_tokens')
  assert.equal(validated.compat.requiresReasoningContentOnAssistantMessages, true)
})

test('a custom API is refused before anything is written when it cannot serve', async () => {
  const { rt, writes } = dsh()
  const custom = { custom: true, provider: 'relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', models: ['m'] }
  await assert.rejects(rt.addProvider({ ...custom, provider: 'My Relay' }), /lowercase letters, digits and dashes/)
  await assert.rejects(rt.addProvider({ ...custom, provider: 'anthropic' }), /DSH already offers anthropic/)
  await assert.rejects(rt.addProvider({ ...custom, api: 'grpc' }), /protocol must be one of/)
  await assert.rejects(rt.addProvider({ ...custom, baseURL: 'relay.example' }), /http or https/)
  await assert.rejects(rt.addProvider({ ...custom, baseURL: 'ftp://relay.example' }), /http or https/)
  await assert.rejects(rt.addProvider({ ...custom, models: [] }), /at least one model/)
  await assert.rejects(rt.addProvider({ ...custom, models: ['m', ' m '] }), /same id/)
  await assert.rejects(rt.addProvider({ ...custom, key: 'KEY=sk' }), /NAME=value/)
  assert.deepEqual(writes, [])
})

test('fetching models asks DSH about the endpoint, with the typed key for that question only', async () => {
  const { rt, discovered, store } = dsh()
  const models = await rt.discoverModels({ baseURL: 'https://relay.example/v1', api: 'openai-completions', key: 'sk-relay' })
  assert.deepEqual(discovered, [['llm-pi-ai', { baseURL: 'https://relay.example/v1', api: 'openai-completions', apiKey: 'sk-relay' }]])
  assert.deepEqual(models, [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, inputModalities: ['text'] }, { id: 'relay-2' }])
  assert.deepEqual(store, {})
  // A provider DSH ships is answered from its own catalog.
  await rt.discoverModels({ provider: 'anthropic' })
  assert.deepEqual(discovered.at(-1), ['llm-pi-ai', { provider: 'anthropic' }])
})

test('removing a provider takes its key along unless another provider names it', async () => {
  const user = { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' }, kimi: { apiKeyEnv: 'MOONSHOTAI_API_KEY', api: 'openai-completions', baseURL: 'https://k.example/v1', models: [{ id: 'k' }] }, relay: { apiKeyEnv: 'RELAY_API_KEY', api: 'openai-completions', baseURL: 'https://r.example/v1', models: [{ id: 'r' }] } } }
  const { rt, store } = dsh({ user, keys: { MOONSHOTAI_API_KEY: 'a', RELAY_API_KEY: 'b' } })
  await rt.removeProvider('moonshotai')
  assert.equal(store.MOONSHOTAI_API_KEY, 'a')
  const view = await rt.removeProvider('relay')
  assert.equal('RELAY_API_KEY' in store, false)
  assert.deepEqual(view.providers.map(provider => provider.id), ['deepseek-official', 'kimi'])
  await assert.rejects(rt.removeProvider('relay'), /relay is not set up/)
  await assert.rejects(rt.removeProvider('deepseek-official'), /not set up/)
})

test('a route that comes with the setup stays', async () => {
  const { rt } = dsh({ base: { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } } } })
  assert.equal(row(await rt.providersView(), 'moonshotai').removable, false)
  await assert.rejects(rt.removeProvider('moonshotai'), /comes with this setup/)
})

test('a changed credential drops the cached catalog', async () => {
  const { rt, store, listeners } = dsh()
  assert.deepEqual(await needing(rt), ['deepseek-official'])
  store.DEEPSEEK_API_KEY = 'k'
  assert.deepEqual((await rt.catalog()).filter(entry => entry.needsKey).map(entry => entry.provider), ['deepseek-official'])
  listeners.get('credentials/reference-updated')()
  assert.deepEqual((await rt.catalog()).filter(entry => entry.needsKey).map(entry => entry.provider), [])
})

test('an API key is what an HTTP header carries, without a NAME= or quotes', () => {
  assert.equal(checkKey(' sk-abc '), 'sk-abc')
  assert.equal(checkKey('YWJj=='), 'YWJj==')
  assert.throws(() => checkKey('   '), /Enter the API key/)
  assert.throws(() => checkKey(undefined), /Enter the API key/)
  assert.throws(() => checkKey('DEEPSEEK_API_KEY=sk-abc'), /not a NAME=value line/)
  assert.throws(() => checkKey('"sk-abc"'), /without quotes/)
  assert.throws(() => checkKey('sk abc'), /no spaces/)
  assert.throws(() => checkKey('sk-密钥'), /no spaces/)
})

test('a route\'s key reference follows DSH\'s own Models page', () => {
  assert.equal(keyRefFor('moonshotai'), 'MOONSHOTAI_API_KEY')
  assert.equal(keyRefFor('my-gateway2'), 'MY_GATEWAY2_API_KEY')
})

const magpieProfiles = writes => writes.filter(([ns]) => ns === 'llm-pi-ai').flatMap(([, ops]) => ops.filter(op => op.op === 'set' && op.path.length === 2).map(op => [op.path[1], op.value]))

async function gateway(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return `http://127.0.0.1:${server.address().port}/v1`
}

const magpieListing = { data: [{
  id: 'codex/gpt-6-astra', display_name: 'GPT-6-Astra', context_window: 272000, max_output_tokens: 128000,
  modalities: { input: ['text', 'image'] }, reasoning: true, reasoning_levels: ['low', 'high', 'xhigh', 'max', 'ultra'], native_endpoints: ['/v1/responses'],
}] }

test('each Magpie connection gets an independent route, model reference and credential', async () => {
  const { rt, store, writes } = dsh({ keys: { OPENAI_API_KEY: 'unrelated-openai', MAGPIE_API_KEY: 'unrelated-magpie' } })
  const models = magpieModels(magpieListing)
  await rt.addProvider({ preset: 'magpie', provider: 'deepseek-official', models })
  await rt.addProvider({ preset: 'magpie', name: 'Magpie work', api: 'openai-completions', key: 'test-work', models })
  const [[first, a], [second, b]] = magpieProfiles(writes)
  assert.match(first, /^magpie-[a-f0-9-]{36}$/)
  assert.match(second, /^magpie-[a-f0-9-]{36}$/)
  assert.notEqual(first, second)
  assert.notEqual(a.apiKeyEnv, b.apiKeyEnv)
  assert.equal(a.apiKeyEnv, keyRefFor(first))
  assert.equal(store[a.apiKeyEnv], MAGPIE_LOCAL_KEY)
  assert.equal(store[b.apiKeyEnv], 'test-work')
  assert.equal(a.baseURL, MAGPIE.baseURL)
  assert.equal(a.api, 'openai-responses')
  assert.equal(b.api, 'openai-completions')
  assert.equal(a.displayName, 'Magpie')
  assert.equal(b.displayName, 'Magpie work')
  for (const [id, profile] of [[first, a], [second, b]]) {
    const parsed = PiAiConfig({ providers: { [id]: profile } }).providers.get()[id]
    assert.deepEqual(parsed.models[0].input, ['text', 'image'])
    assert.equal(parsed.models[0].contextWindow, 272000)
    assert.equal(parsed.models[0].maxTokens, 128000)
    assert.deepEqual(parsed.models[0].reasoningEfforts, { low: 'low', high: 'high', xhigh: 'xhigh', max: 'max' })
    assert.equal(parsed.models[0].nativeApis, undefined)
    assert.equal(parsed.compat.supportsDeveloperRole, false)
  }
  const view = await rt.providersView()
  assert.deepEqual(row(view, first).models.map(model => model.ref), [`${first}/codex/gpt-6-astra`])
  assert.deepEqual(row(view, second).models.map(model => model.ref), [`${second}/codex/gpt-6-astra`])
  assert.equal((await needing(rt)).includes(first), false)
  await rt.removeProvider(first)
  assert.equal(store[a.apiKeyEnv], undefined)
  assert.equal(store[b.apiKeyEnv], 'test-work')
  assert.equal(store.OPENAI_API_KEY, 'unrelated-openai')
  assert.equal(store.MAGPIE_API_KEY, 'unrelated-magpie')
  assert.ok(row(await rt.providersView(), second))
})

test('Magpie rejects unusable drafts before writing a route or credential', async () => {
  const { rt, writes } = dsh()
  const body = { preset: 'magpie', models: ['m'] }
  await assert.rejects(rt.addProvider({ ...body, baseURL: 'https://gateway.example/v1' }), /API key for a remote/)
  await assert.rejects(rt.addProvider({ ...body, baseURL: 'http://u:pass@127.0.0.1:3425/v1' }), /without credentials/)
  await assert.rejects(rt.addProvider({ ...body, baseURL: `${MAGPIE.baseURL}?key=test` }), /without credentials/)
  await assert.rejects(rt.addProvider({ ...body, api: 'anthropic-messages' }), /Responses or Chat Completions/)
  await assert.rejects(rt.addProvider({ ...body, models: [] }), /at least one model/)
  await assert.rejects(rt.addProvider({ ...body, models: ['m', 'm'] }), /same id/)
  await assert.rejects(rt.addProvider({ ...body, key: 'KEY=test' }), /NAME=value/)
  assert.deepEqual(writes, [])
})

test('Magpie discovery reads only the local model listing and preserves its capabilities', async (t) => {
  const requests = []
  const baseURL = await gateway(t, (req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(magpieListing))
  })
  const { rt, store, writes, discovered } = dsh()
  const models = await rt.discoverModels({ preset: 'magpie', baseURL: `${baseURL}/responses` })
  assert.deepEqual(requests, [{ method: 'GET', path: '/v1/models', authorization: `Bearer ${MAGPIE_LOCAL_KEY}` }])
  assert.deepEqual(models, magpieModels(magpieListing))
  assert.deepEqual(discovered, [])
  assert.deepEqual(store, {})
  assert.deepEqual(writes, [])
})

test('Magpie remote discovery uses only the draft key and does not persist it', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init })
    return new Response(JSON.stringify({ data: [{ id: 'cursor/auto', reasoning: false }] }))
  })
  const { rt, store, writes } = dsh({ keys: { OPENAI_API_KEY: 'unrelated', MAGPIE_API_KEY: 'unrelated' } })
  const models = await rt.discoverModels({ preset: 'magpie', baseURL: 'https://gateway.example/v1', api: 'openai-completions', key: 'test-draft' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://gateway.example/v1/models')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers.Authorization, 'Bearer test-draft')
  assert.equal(calls[0].redirect, 'error')
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.deepEqual(models, [{ id: 'cursor/auto', reasoningEfforts: false }])
  assert.deepEqual(store, { OPENAI_API_KEY: 'unrelated', MAGPIE_API_KEY: 'unrelated' })
  assert.deepEqual(writes, [])
})

test('Magpie discovery refuses redirects instead of forwarding the draft key', async (t) => {
  let redirected = false
  const destination = await gateway(t, (_req, res) => { redirected = true; res.end('{"data":[]}') })
  const baseURL = await gateway(t, (_req, res) => res.writeHead(302, { Location: `${destination}/models` }).end())
  const { rt } = dsh()
  await assert.rejects(rt.discoverModels({ preset: 'magpie', baseURL, key: 'test-draft' }), /Could not read Magpie models/)
  assert.equal(redirected, false)
})

test('Magpie discovery failures are bounded and never echo keys or upstream bodies', async (t) => {
  const { rt, writes } = dsh()
  const responses = [
    () => new Response('test-private-key', { status: 401 }),
    () => new Response('not-json test-private-key'),
    () => new Response('{"error":"test-private-key"}'),
    () => new Response('[]', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
    () => new Response(' '.repeat(2 * 1024 * 1024 + 1)),
    () => { throw new Error('network failed: test-private-key') },
  ]
  t.mock.method(globalThis, 'fetch', async () => responses.shift()())
  for (let count = responses.length; count > 0; count -= 1) {
    await assert.rejects(rt.discoverModels({ preset: 'magpie', key: 'test-private-key' }), (error) => {
      assert.equal(error.code, 'bot/invalid')
      assert.equal(error.message.includes('test-private-key'), false)
      return true
    })
  }
  assert.deepEqual(writes, [])
})
