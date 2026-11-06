import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeRuntimeProfile, resolveRuntimeProfile, RuntimeProfileError } from '../src/shared/runtime-profile.js'

const profile = (botId = 'writer') => ({
  version: 1, botId,
  model: { connectionId: `${botId}-api`, model: 'shared-model', effort: 'high' },
  interfaces: [`${botId}-repo`], skills: [`${botId}-skill`],
})
const catalog = () => ({
  modelConnections: ['writer', 'builder'].map(botId => ({
    id: `${botId}-api`, provider: `turbo-${botId}`, available: true, allowedBotIds: [botId],
    models: [{ id: 'shared-model', efforts: ['low', 'high'] }],
  })),
  interfaceConnections: ['writer', 'builder'].map(botId => ({
    id: `${botId}-repo`, capability: `repo-${botId}`, available: true, allowedBotIds: [botId],
  })),
  skills: ['writer', 'builder'].map(botId => ({
    id: `${botId}-skill`, capability: `skill-${botId}`, available: true, allowedBotIds: [botId],
  })),
})
const rejects = (fn, code) => assert.throws(fn, error => error instanceof RuntimeProfileError && error.code === code)

test('same model resolves to separate routes and capabilities for two Bots', () => {
  const registry = catalog()
  const before = structuredClone(registry)
  assert.deepEqual(resolveRuntimeProfile('writer', profile(), registry), {
    botId: 'writer', model: { provider: 'turbo-writer', model: 'shared-model', reasoningEffort: 'high' },
    capabilities: ['repo-writer', 'skill-writer'],
    bindings: { modelConnectionId: 'writer-api', interfaceIds: ['writer-repo'], skillIds: ['writer-skill'] },
  })
  const builder = resolveRuntimeProfile('builder', profile('builder'), registry)
  assert.equal(builder.model.provider, 'turbo-builder')
  assert.deepEqual(builder.capabilities, ['repo-builder', 'skill-builder'])
  assert.deepEqual(registry, before)
})

test('authenticated Bot id must match the profile, even when connections are shared', () => {
  const registry = catalog()
  registry.modelConnections[0].allowedBotIds.push('builder')
  rejects(() => resolveRuntimeProfile('builder', profile(), registry), 'bot-mismatch')
})

test('a Bot cannot select another Bot’s model account', () => {
  const input = profile()
  input.model.connectionId = 'builder-api'
  rejects(() => resolveRuntimeProfile('writer', input, catalog()), 'connection-denied')
})

test('an interface or skill grant is checked separately from the model grant', () => {
  const input = profile()
  input.interfaces = ['builder-repo']
  rejects(() => resolveRuntimeProfile('writer', input, catalog()), 'interface-denied')
  input.interfaces = []
  input.skills = ['builder-skill']
  rejects(() => resolveRuntimeProfile('writer', input, catalog()), 'skill-denied')
})

test('explicit sharing works and revocation takes effect on the next resolution', () => {
  const input = profile('builder')
  input.interfaces = ['writer-repo']
  const registry = catalog()
  registry.interfaceConnections[0].allowedBotIds.push('builder')
  assert.deepEqual(resolveRuntimeProfile('builder', input, registry).capabilities, ['repo-writer', 'skill-builder'])
  registry.interfaceConnections[0].allowedBotIds = ['writer']
  rejects(() => resolveRuntimeProfile('builder', input, registry), 'interface-denied')
})

test('missing or unready explicit model connection never falls back to another route', () => {
  const registry = catalog()
  registry.modelConnections[0].available = false
  rejects(() => resolveRuntimeProfile('writer', profile(), registry), 'connection-unavailable')
  registry.modelConnections.shift()
  rejects(() => resolveRuntimeProfile('writer', profile(), registry), 'connection-missing')
})

test('missing model and unsupported effort stop resolution', () => {
  const input = profile()
  input.model.model = 'removed-model'
  rejects(() => resolveRuntimeProfile('writer', input, catalog()), 'model-missing')
  input.model.model = 'shared-model'
  input.model.effort = 'unsupported'
  rejects(() => resolveRuntimeProfile('writer', input, catalog()), 'effort-unavailable')
})

test('omitted effort leaves the model default to DSH without inventing one', () => {
  const input = profile()
  delete input.model.effort
  assert.deepEqual(resolveRuntimeProfile('writer', input, catalog()).model, { provider: 'turbo-writer', model: 'shared-model' })
})

test('missing and unready interfaces or skills do not yield a partial plan', () => {
  for (const [list, kind] of [['interfaceConnections', 'interface'], ['skills', 'skill']]) {
    const registry = catalog()
    registry[list][0].available = false
    rejects(() => resolveRuntimeProfile('writer', profile(), registry), `${kind}-unavailable`)
    registry[list].shift()
    rejects(() => resolveRuntimeProfile('writer', profile(), registry), `${kind}-missing`)
  }
})

test('empty lists attach nothing; repeated selections are normalized and detached', () => {
  const input = profile()
  input.interfaces.push('writer-repo')
  const normalized = normalizeRuntimeProfile(input)
  assert.deepEqual(normalized.interfaces, ['writer-repo'])
  normalized.interfaces.length = 0
  normalized.model.model = 'edited'
  assert.equal(input.model.model, 'shared-model')
  assert.equal(input.interfaces.length, 2)
  input.interfaces = []
  input.skills = []
  assert.deepEqual(resolveRuntimeProfile('writer', input, catalog()).capabilities, [])
})

test('returned plans cannot alter source profiles, catalogs or a later resolution', () => {
  const input = profile()
  const registry = catalog()
  const plan = resolveRuntimeProfile('writer', input, registry)
  plan.model.provider = 'changed'
  plan.capabilities.push('builder-skill')
  plan.bindings.interfaceIds.push('builder-repo')
  const next = resolveRuntimeProfile('writer', input, registry)
  assert.equal(next.model.provider, 'turbo-writer')
  assert.deepEqual(next.bindings.interfaceIds, ['writer-repo'])
  assert.deepEqual(next.capabilities, ['repo-writer', 'skill-writer'])
})

test('unknown fields, future versions and malformed references are rejected without echoing values', () => {
  const fakeSecret = 'fixture-only-not-a-credential'
  for (const input of [null, [], { ...profile(), version: 2 }, { ...profile(), apiKey: fakeSecret }, { ...profile(), skills: 'all' }, { ...profile(), interfaces: [42] }, { ...profile(), botId: ' writer ' }]) {
    assert.throws(() => normalizeRuntimeProfile(input), error => error.code === 'invalid-profile' && !error.message.includes(fakeSecret))
  }
  const input = profile()
  input.model.apiKey = fakeSecret
  rejects(() => normalizeRuntimeProfile(input), 'invalid-profile')
})

test('catalog entries require explicit grants, availability and unique ids', () => {
  for (const mutate of [
    registry => { delete registry.modelConnections[0].allowedBotIds },
    registry => { delete registry.modelConnections[0].available },
    registry => { registry.skills.push({ ...registry.skills[0] }) },
    registry => { registry.modelConnections[0].models.push({ id: 'shared-model' }) },
    registry => { registry.modelConnections[0].apiKey = 'fixture-only' },
    registry => { registry.skills[0].allowedBotIds = '*' },
  ]) {
    const registry = catalog()
    mutate(registry)
    rejects(() => resolveRuntimeProfile('writer', profile(), registry), 'invalid-catalog')
  }
  const registry = catalog()
  registry.modelConnections[0].allowedBotIds = []
  rejects(() => resolveRuntimeProfile('writer', profile(), registry), 'connection-denied')
})

test('separate account ids cannot disguise a shared provider route or MCP mount', () => {
  for (const [list, target] of [['modelConnections', 'provider'], ['interfaceConnections', 'capability']]) {
    const registry = catalog()
    registry[list][1][target] = registry[list][0][target]
    rejects(() => resolveRuntimeProfile('writer', profile(), registry), 'invalid-catalog')
  }
})

test('an interface and a skill cannot resolve to the same capability name', () => {
  const registry = catalog()
  registry.skills[0].capability = 'repo-writer'
  rejects(() => resolveRuntimeProfile('writer', profile(), registry), 'capability-collision')
})

test('unselected cross-kind capability aliases cannot bypass separate Bot grants', () => {
  const registry = catalog()
  registry.skills[1].capability = registry.interfaceConnections[0].capability
  rejects(() => resolveRuntimeProfile('writer', profile(), registry), 'capability-collision')
})

test('sparse lists and null optional lists cannot normalize to invalid references', () => {
  const sparse = []
  sparse.length = 1
  for (const value of [sparse, null]) {
    for (const key of ['interfaces', 'skills']) rejects(() => normalizeRuntimeProfile({ ...profile(), [key]: value }), 'invalid-profile')
    const registry = catalog()
    registry.modelConnections[0].models[0].efforts = value
    rejects(() => resolveRuntimeProfile('writer', profile(), registry), 'invalid-catalog')
  }
})

test('prototype names are literal ids and cannot read inherited catalog properties', () => {
  const input = profile()
  input.model.connectionId = '__proto__'
  rejects(() => resolveRuntimeProfile('writer', input, catalog()), 'connection-missing')
})
