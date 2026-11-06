// Turbo's configuration boundary. It resolves references only: the host owns
// credentials, persists profiles and applies a plan to the Bot's Sessions.
export class RuntimeProfileError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RuntimeProfileError'
    this.code = code
  }
}

const fail = (code, message) => { throw new RuntimeProfileError(code, message) }
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim() && !/\p{Cc}/u.test(value)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const fields = (value, names) => record(value) && Object.keys(value).every(key => names.includes(key))
const strings = value => Array.isArray(value) && [...value].every(text)
const unique = values => [...new Set(values)]

/** Return a detached, serializable v1 profile. Unknown fields are rejected. */
export function normalizeRuntimeProfile(value) {
  if (!fields(value, ['version', 'botId', 'model', 'interfaces', 'skills']) || value.version !== 1 || !text(value.botId)) {
    fail('invalid-profile', 'A runtime profile requires version 1 and a Bot id.')
  }
  const model = value.model
  if (!fields(model, ['connectionId', 'model', 'effort']) || !text(model.connectionId) || !text(model.model) || (model.effort !== undefined && !text(model.effort))) {
    fail('invalid-profile', 'Choose a model connection, a model and an optional thinking level.')
  }
  const interfaces = value.interfaces === undefined ? [] : value.interfaces
  const skills = value.skills === undefined ? [] : value.skills
  if (!strings(interfaces) || !strings(skills)) {
    fail('invalid-profile', 'Interfaces and skills must be lists of reference ids.')
  }
  return {
    version: 1,
    botId: value.botId,
    model: { connectionId: model.connectionId, model: model.model, ...(model.effort === undefined ? {} : { effort: model.effort }) },
    interfaces: unique(interfaces),
    skills: unique(skills),
  }
}

function index(items, kind) {
  if (!Array.isArray(items)) fail('invalid-catalog', 'The runtime catalog requires connection and skill lists.')
  const result = new Map()
  const targets = new Set()
  for (const item of items) {
    const names = kind === 'model'
      ? ['id', 'provider', 'models', 'allowedBotIds', 'available']
      : ['id', 'capability', 'allowedBotIds', 'available']
    if (!fields(item, names) || !text(item.id) || !strings(item.allowedBotIds) || typeof item.available !== 'boolean') {
      fail('invalid-catalog', 'Every catalog entry requires an id, explicit Bot grants and availability.')
    }
    if (result.has(item.id)) fail('invalid-catalog', 'Catalog ids must be unique within each list.')
    const target = kind === 'model' ? item.provider : item.capability
    if (!text(target)) fail('invalid-catalog', 'A catalog entry must name a DSH provider or capability.')
    // Two account labels for one route/mount still use the same credentials.
    if (targets.has(target)) fail('invalid-catalog', 'Distinct connections must use distinct DSH providers or capabilities; share one entry explicitly instead.')
    targets.add(target)
    if (kind === 'model') {
      if (!Array.isArray(item.models)) fail('invalid-catalog', 'A model connection requires its served models.')
      const modelIds = new Set()
      for (const model of item.models) {
        if (!fields(model, ['id', 'efforts']) || !text(model.id) || !strings(model.efforts === undefined ? [] : model.efforts) || modelIds.has(model.id)) {
          fail('invalid-catalog', 'Served models require unique ids and optional thinking-level ids.')
        }
        modelIds.add(model.id)
      }
    }
    result.set(item.id, item)
  }
  return result
}

function granted(entries, id, botId, kind) {
  const entry = entries.get(id)
  if (entry === undefined) fail(`${kind}-missing`, `A selected ${kind} no longer exists.`)
  if (!entry.allowedBotIds.includes(botId)) fail(`${kind}-denied`, `This Bot is not allowed to use a selected ${kind}.`)
  if (!entry.available) fail(`${kind}-unavailable`, `A selected ${kind} is not ready.`)
  return entry
}

/**
 * Resolve a plan against host-owned catalog metadata, without I/O or fallback.
 * botId comes from the authenticated Session, never from the submitted profile.
 * This validates bindings; it is not a sandbox or a credential broker.
 */
export function resolveRuntimeProfile(botId, input, catalog) {
  const profile = normalizeRuntimeProfile(input)
  if (!text(botId) || profile.botId !== botId) fail('bot-mismatch', 'The runtime profile belongs to a different Bot.')
  if (!fields(catalog, ['modelConnections', 'interfaceConnections', 'skills'])) fail('invalid-catalog', 'Use a runtime catalog containing reference metadata only.')
  const models = index(catalog.modelConnections, 'model')
  const interfaces = index(catalog.interfaceConnections, 'interface')
  const skills = index(catalog.skills, 'skill')
  const interfaceTargets = new Set([...interfaces.values()].map(entry => entry.capability))
  for (const skill of skills.values()) {
    if (interfaceTargets.has(skill.capability)) fail('capability-collision', 'Interface and skill catalogs must use distinct capability names.')
  }
  const connection = granted(models, profile.model.connectionId, botId, 'connection')
  const model = connection.models.find(entry => entry.id === profile.model.model)
  if (model === undefined) fail('model-missing', 'The selected model is not served by this connection.')
  const effort = profile.model.effort
  if (effort !== undefined && !model.efforts?.includes(effort)) fail('effort-unavailable', 'The selected thinking level is not served by this model.')
  const selectedInterfaces = profile.interfaces.map(id => granted(interfaces, id, botId, 'interface'))
  const selectedSkills = profile.skills.map(id => granted(skills, id, botId, 'skill'))
  const capabilities = [...selectedInterfaces, ...selectedSkills].map(entry => entry.capability)
  return {
    botId,
    model: { provider: connection.provider, model: model.id, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
    capabilities,
    bindings: { modelConnectionId: connection.id, interfaceIds: [...profile.interfaces], skillIds: [...profile.skills] },
  }
}
