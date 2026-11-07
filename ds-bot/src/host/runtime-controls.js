// Apply the user's per-Bot choices to own chats, group Sessions and new parts.
// The tool guard also covers stale calls and calls forwarded by run_code.
import { allowsTool, dshToolIdentity, parseToolScope } from '../shared/tool-scope.js'

export function install(rt) {
  const { ctx } = rt
  const botFor = sessionId => rt.botOf(rt.selfOf(sessionId))
  const localCalls = new Map()
  rt.hasActiveLocalAgentCalls = botId => (localCalls.get(botId) ?? 0) > 0
  const permits = (scope, name) => {
    if (scope === undefined) return true
    if (name === 'run_code') {
      // PTC exposes only this transport; every SDK call goes through tools.guard
      // with the same agent. A native wildcard addresses tools, not transport.
      const parsed = parseToolScope(scope)
      return parsed.ok && parsed.scope?.allow?.length !== 0
        && !parsed.scope?.deny?.includes('native:run_code')
    }
    return allowsTool(scope, dshToolIdentity(name))
  }

  ctx.tools.guard((exec) => {
    const bot = botFor(exec.agent?.session?.id ?? exec.agent?.id)
    if (bot === undefined || permits(bot.toolScope, exec.name)) return undefined
    return `Tool ${exec.name} is disabled for ${bot.name}. The user can change Tool access in this Bot's settings.`
  })

  ctx.on('llm/stream', (options, next) => (async function* applyRuntimeControls() {
    if (options.sessionId === undefined) { yield* next(); return }
    await rt.load()
    const bot = botFor(options.sessionId)
    if (bot === undefined) { yield* next(); return }

    // Titles and other Harness auxiliary requests have their own model policy.
    if (bot.modelFallback === false && options.purpose === undefined) {
      const ref = await rt.desiredModel(bot)
      if (ref === undefined || `${options.provider}/${options.model}` !== ref) {
        throw new Error(`The model connection for ${bot.name} is fixed. Select its configured model in Bot settings before sending a message.`)
      }
    }
    const local = rt.isLocalAgentRoute?.(options.provider) === true
    if (bot.toolScope !== undefined) {
      if (!parseToolScope(bot.toolScope).ok) throw new Error(`Tool access for ${bot.name} is invalid. Update it in Bot settings.`)
      // CLI-native tools execute outside DSH's guards.
      if (local) throw new Error('Tool access requires a hosted API model. Local agents have their own tools; clear Tool access or select an API model.')
    }
    if (local) localCalls.set(bot.id, (localCalls.get(bot.id) ?? 0) + 1)
    try {
      // Preserve the Session-log request and its prepared adapter. SDK catalogs
      // may remain visible; the execution guard enforces every actual tool call.
      yield* next()
    } finally {
      if (local) {
        const remaining = localCalls.get(bot.id) - 1
        if (remaining > 0) localCalls.set(bot.id, remaining)
        else localCalls.delete(bot.id)
      }
    }
  })())
}
