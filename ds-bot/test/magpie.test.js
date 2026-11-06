import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { MAGPIE, MAX_MAGPIE_MODELS, isLocalMagpie, magpieEndpoint, magpieModels, magpieProtocol } from '../src/shared/magpie.js'

// Render the real page and its forms with the same lightweight hook approach used
// by other client tests. Stub only shared visual primitives and translations.
const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const visuals = {
  './icons.js': 'export const CheckIcon = () => null; export const TrashIcon = () => null',
  './secret-card.js': "import {createElement as h} from 'react'; export const KeyIcon = () => null; export const MaskedInput = ({value,onChange,label}) => h('input', {value, 'aria-label':label, onChange:e=>onChange(e.target.value)})",
  './motion.js': "import {createElement as h} from 'react'; export const SPRING_SHAPE = {duration:0,easing:'linear'}; export const Segmented = ({children}) => h('div',null,children)",
  './i18n.js': "export const hostText = s => s; export const t = (s,p={}) => s.replace(/\\{(\\w+)\\}/g,(_,k)=>p[k]??k)",
}
const { outputFiles } = await build({
  entryPoints: [join(plugin, 'src/client/providers-page.js')], bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
  plugins: [{
    name: 'visual-primitives',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/(icons|secret-card|motion|i18n)\.js$/ }, args => ({ path: args.path, namespace: 'visual' }))
      builder.onLoad({ filter: /.*/, namespace: 'visual' }, args => ({ contents: visuals[args.path], loader: 'js' }))
    },
  }],
})
const flush = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))

function page(actions = {}) {
  const states = new Map()
  const effects = []
  const errors = []
  let current
  let index = 0
  let tree
  const useState = (initial) => {
    const slots = current
    const slot = index++
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
    return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; render() }]
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState,
    useRef: value => useState(() => ({ current: value }))[0],
    useEffect: (effect, deps) => {
      const slot = index++
      const previous = current[slot]
      if (previous === undefined || deps.some((dep, i) => dep !== previous[i])) {
        current[slot] = deps
        effects.push(effect)
      }
    },
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => react })
  const view = { available: true, providers: [], addable: [], protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'] }
  const props = {
    actions: { providers: async () => view, ...actions },
    run: promise => promise.then(() => true, error => { errors.push(error.message); return false }),
    Section: ({ children }) => react.createElement('section', null, children),
  }
  function expand(node, path) {
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${i}`))
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      if (!states.has(path)) states.set(path, [])
      current = states.get(path)
      index = 0
      return expand(node.type(node.props), `${path}/component`)
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children, `${path}/children`) } }
  }
  function render() {
    tree = expand({ type: module.exports.ProvidersPage, props }, 'root')
    while (effects.length) effects.shift()()
  }
  const nodes = (match) => {
    const found = []
    const visit = (node) => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!node || typeof node !== 'object' || node.props.hidden) return
      if (match(node)) found.push(node)
      visit(node.props.children)
    }
    visit(tree)
    return found
  }
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : node == null ? '' : String(node)
  const button = label => {
    const result = nodes(node => node.type === 'button' && text(node) === label)[0]
    assert.ok(result, `button ${label}`)
    return result
  }
  const field = label => {
    const result = nodes(node => ['input', 'select'].includes(node.type) && node.props['aria-label'] === label)[0]
    assert.ok(result, `field ${label}`)
    return result
  }
  const fill = (label, value) => field(label).props.onChange({ target: { value } })
  render()
  return { nodes, button, field, fill, errors }
}

test('Magpie endpoints accept the root or an OpenAI request URL without duplicating v1', () => {
  assert.equal(magpieEndpoint(), MAGPIE.baseURL)
  assert.equal(magpieEndpoint(' http://127.0.0.1:3425/ '), MAGPIE.baseURL)
  assert.equal(magpieEndpoint(`${MAGPIE.baseURL}/responses/`), MAGPIE.baseURL)
  assert.equal(magpieEndpoint(`${MAGPIE.baseURL}/chat/completions`), MAGPIE.baseURL)
  assert.equal(magpieEndpoint(`${MAGPIE.baseURL}/models`), MAGPIE.baseURL)
  assert.equal(magpieEndpoint('https://example.test/proxy/v1/'), 'https://example.test/proxy/v1')
  for (const value of ['ftp://example.test', 'example.test', '', 'http://u:p@example.test/v1', 'https://example.test/v1?key=x', 'https://example.test/v1#x']) {
    assert.throws(() => magpieEndpoint(value), { code: 'bot/invalid' })
  }
})

test('only explicit loopback hosts receive keyless local Magpie behavior', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.equal(isLocalMagpie(`http://${host}:3425/v1`), true)
  for (const host of ['magpie.example', 'localhost.example', '192.168.0.2', '0.0.0.0']) assert.equal(isLocalMagpie(`http://${host}:3425/v1`), false)
  assert.equal(magpieProtocol(), 'openai-responses')
  assert.equal(magpieProtocol('openai-completions'), 'openai-completions')
  assert.throws(() => magpieProtocol('anthropic-messages'), { code: 'bot/invalid' })
})

test('Magpie metadata keeps namespaced ids and only capabilities the DSH adapter supports', () => {
  assert.deepEqual(magpieModels({ data: [null, {}, { id: '  ' }, {
    id: ' codex/model ', display_name: ' Model ', context_window: 272000, max_output_tokens: 128000,
    modalities: { input: ['text', 'image', 'pdf', 'text'] }, reasoning_levels: ['none', 'low', 'high', 'ultra', null],
    native_endpoints: ['/v1/responses'], private_field: 'not-retained',
  }, { id: 'codex/model' }, { id: 'other/model', reasoning: false }, { id: 'plain', context_window: -1, max_output_tokens: '100', reasoning: true }] }), [
    { id: 'codex/model', name: 'Model', contextWindow: 272000, maxTokens: 128000, inputModalities: ['text', 'image'], reasoningEfforts: { off: 'none', low: 'low', high: 'high' }, nativeApis: ['openai-responses'] },
    { id: 'other/model', reasoningEfforts: false },
    { id: 'plain' },
  ])
  assert.deepEqual(magpieModels({ data: [] }), [])
  assert.throws(() => magpieModels({ error: 'upstream detail' }), /did not return a model list/)
  assert.equal(magpieModels({ data: Array.from({ length: 600 }, (_, i) => ({ id: `m-${i}` })) }).length, MAX_MAGPIE_MODELS)
})

test('the Magpie entry opens a usable preset and submits one independent connection', async () => {
  const adds = []
  let finish
  const ui = page({ addProvider: body => { adds.push(body); return new Promise(resolve => { finish = resolve }) } })
  await flush()
  ui.button('Connect Magpie').props.onClick()
  assert.equal(ui.field('Endpoint').props.value, MAGPIE.baseURL)
  assert.equal(ui.field('Protocol').props.value, 'openai-responses')
  assert.equal(ui.nodes(node => node.props['aria-label'] === 'Provider ID').length, 0)
  ui.fill('Connection name', 'Magpie work')
  ui.fill('Model ids', 'codex/gpt-6-astra, codex/gpt-6-astra')
  const add = ui.button('Add')
  assert.equal(add.props.disabled, false)
  add.props.onClick()
  add.props.onClick()
  await flush()
  assert.equal(adds.length, 1)
  assert.deepEqual(plain(adds[0]), { custom: true, preset: 'magpie', name: 'Magpie work', baseURL: MAGPIE.baseURL, api: 'openai-responses', key: '', models: [{ id: 'codex/gpt-6-astra' }] })
  assert.equal(ui.button('Adding…').props.disabled, true)
  assert.equal(ui.field('Endpoint').props.disabled, true)
  finish()
  await flush()
  assert.ok(ui.button('Connect Magpie'))
  assert.deepEqual(ui.errors, [])
})

test('editing a Magpie endpoint discards a late model listing from the previous endpoint', async () => {
  const requests = []
  let finish
  const ui = page({ providerModels: body => { requests.push(body); return new Promise(resolve => { finish = resolve }) } })
  await flush()
  ui.button('Connect Magpie').props.onClick()
  ui.button('Fetch models').props.onClick()
  await flush()
  ui.fill('Endpoint', 'http://localhost:4444/v1')
  finish([{ id: 'old/model' }])
  await flush()
  assert.equal(requests[0].preset, 'magpie')
  assert.equal(requests[0].baseURL, MAGPIE.baseURL)
  assert.equal(ui.nodes(node => node.type === 'code').length, 0)
  assert.equal(ui.button('Add').props.disabled, true)
  assert.equal(ui.button('Fetch models').props.disabled, false)
  ui.button('Fetch models').props.onClick()
  await flush()
  finish([{ id: 'new/model', contextWindow: 200000, inputModalities: ['text', 'image'] }])
  await flush()
  assert.ok(ui.button('new/model'))
})

test('a failed discovery still allows manual model entry and a failed save can retry', async () => {
  let attempts = 0
  const ui = page({
    providerModels: async () => { throw new Error('Magpie unavailable') },
    addProvider: async () => { attempts += 1; throw new Error('Try again') },
  })
  await flush()
  ui.button('Connect Magpie').props.onClick()
  ui.button('Fetch models').props.onClick()
  await flush()
  assert.deepEqual(ui.errors, ['Magpie unavailable'])
  ui.fill('Protocol', 'openai-completions')
  ui.fill('Model ids', 'cursor/auto')
  ui.button('Add').props.onClick()
  await flush()
  assert.equal(ui.button('Add').props.disabled, false)
  ui.button('Add').props.onClick()
  await flush()
  assert.equal(attempts, 2)
})
