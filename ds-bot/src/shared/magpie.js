// Magpie's OpenAI-compatible gateway advertises capabilities beyond the OpenAI model
// list. Keep the adapter's supported vocabulary while retaining gateway model ids.
export const MAGPIE = {
  id: 'magpie',
  name: 'Magpie',
  baseURL: 'http://127.0.0.1:3425/v1',
  api: 'openai-responses',
  protocols: ['openai-responses', 'openai-completions'],
}

export const MAGPIE_LOCAL_KEY = 'magpie-local'
export const MAX_MAGPIE_MODELS = 500
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export function magpieEndpoint(value = MAGPIE.baseURL) {
  let url
  try { url = new URL(typeof value === 'string' ? value.trim() : '') } catch { throw invalid('Enter the endpoint as an http or https address') }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid('Enter the endpoint as an http or https address')
  if (url.username || url.password || url.search || url.hash) throw invalid('Use an endpoint without credentials, a query or a fragment')
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|models)$/, '')
  url.pathname = path === '' ? '/v1' : path
  return url.href.replace(/\/+$/, '')
}

export function isLocalMagpie(baseURL) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)
}

export function magpieProtocol(api = MAGPIE.api) {
  if (!MAGPIE.protocols.includes(api)) throw invalid('Magpie uses OpenAI Responses or Chat Completions')
  return api
}

export function reasoningEfforts(value) {
  if (value === false) return false
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = EFFORTS.filter(level => Object.hasOwn(value, level))
    .filter(level => (level === 'off' && value[level] === null) || (typeof value[level] === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value[level])))
    .map(level => [level, value[level]])
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function magpieModels(body) {
  if (!Array.isArray(body?.data)) throw invalid('Magpie did not return a model list. Enter model ids manually.')
  const seen = new Set()
  const whole = (...values) => values.find(value => Number.isSafeInteger(value) && value > 0)
  const models = []
  for (const raw of body.data) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = [raw.name, raw.display_name, raw.displayName].find(value => typeof value === 'string' && value.trim() !== '')
    const contextWindow = whole(raw.contextWindow, raw.context_window, raw.context_length, raw.max_input_tokens)
    const maxTokens = whole(raw.maxTokens, raw.max_output_tokens, raw.max_tokens)
    const declaredInput = raw.inputModalities ?? raw.modalities?.input ?? raw.input
    const input = Array.isArray(declaredInput) ? [...new Set(declaredInput.filter(kind => ['text', 'image'].includes(kind)))] : []
    const levels = raw.reasoning_levels ?? raw.supported_reasoning_levels
    const efforts = raw.reasoning === false ? false : Array.isArray(levels)
      ? reasoningEfforts(Object.fromEntries(levels.filter(level => typeof level === 'string').map(level => [level === 'none' ? 'off' : level, level])))
      : undefined
    const nativeApis = Array.isArray(raw.native_endpoints) ? MAGPIE.protocols.filter(api => raw.native_endpoints.includes(api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions')) : []
    models.push({
      id,
      ...(name ? { name: name.trim() } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(input.length ? { inputModalities: input } : {}),
      ...(efforts !== undefined ? { reasoningEfforts: efforts } : {}),
      ...(nativeApis.length ? { nativeApis } : {}),
    })
    if (models.length === MAX_MAGPIE_MODELS) break
  }
  return models
}
