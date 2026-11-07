import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/bot-settings.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn,
  useRef: current => ({ current }), useId: () => 'id', Fragment: Symbol('Fragment'),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { BotSettingsForm, ToolAccessCard } = module.exports

function walk(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}
function settings(bot, { main = false, rooms = [] } = {}) {
  const roster = { mainBotIds: main ? [bot.id] : [], mainBotId: main ? bot.id : null, rooms, models: [], memory: false }
  return walk(BotSettingsForm({ bot, roster, actions: {}, run: fn => fn }))
}
const bot = { id: 'b', name: 'Writer', role: 'Writer', instructions: '', capabilities: [] }

test('model pin and tool access settings send user choices without changing another Bot', () => {
  const patches = []
  const actions = { updateBot: (id, patch) => patches.push({ id, patch }) }
  const tree = walk(BotSettingsForm({ bot: { ...bot, modelFallback: false }, roster: { mainBotIds: [], rooms: [], models: [], memory: false }, actions, run: value => value }))
  const pin = tree.find(node => node.props?.label === 'Keep this model connection')
  assert.equal(pin.props.on, true)
  pin.props.onChange(false)
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ id: 'b', patch: { modelFallback: true } }])
  const toolPatches = []
  const tools = walk(ToolAccessCard({ bot: { ...bot, toolScope: { allow: ['native:read'], deny: ['native:write'] } }, save: patch => toolPatches.push(patch) }))
  const save = tools.find(node => node.type === 'button' && node.props.children.includes('Save tool access'))
  assert.equal(save.props.disabled, false)
  save.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(toolPatches)), [{ toolScope: { allow: ['native:read'], deny: ['native:write'] } }])
})

test('deny-only settings retain inheritance and a new Bot can enable valid defaults', () => {
  const changes = []
  const tree = walk(ToolAccessCard({ bot: { ...bot, toolScope: { deny: ['native:write'] } }, save: patch => changes.push(patch) }))
  assert.equal(tree.find(node => node.props?.label === 'Only allow listed tools').props.on, false)
  const save = tree.find(node => node.type === 'button')
  assert.equal(save.props.disabled, false)
  save.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [{ toolScope: { deny: ['native:write'] } }])
  const defaults = walk(ToolAccessCard({ bot: { ...bot, toolScope: {} }, save() {} }))
  assert.equal(defaults.find(node => node.type === 'button').props.disabled, false)
})

test('the Private switch is enabled only for a state the host accepts', () => {
  const noFolder = settings(bot).find(node => node.props?.label === 'Private')
  assert.equal(noFolder.props.disabled, true)
  assert.equal(noFolder.props.hint, 'Choose a working folder of its own first.')

  const grouped = settings({ ...bot, workDir: '/work' }, { rooms: [{ id: 'r', members: ['b'] }] }).find(node => node.props?.label === 'Private')
  assert.equal(grouped.props.disabled, true)
  assert.equal(grouped.props.hint, 'Leave its group chats before making it private.')

  const main = settings({ ...bot, workDir: '/work' }, { main: true }).find(node => node.props?.label === 'Private')
  assert.equal(main.props.disabled, true)
  assert.equal(main.props.hint, 'A Main Bot cannot be private.')

  const allowed = settings({ ...bot, workDir: '/work' }).find(node => node.props?.label === 'Private')
  assert.equal(allowed.props.disabled, false)
  assert.equal(allowed.props.on, false)
})

test('a private Bot can always turn privacy off, and cannot become Main or be duplicated', () => {
  const tree = settings({ ...bot, workDir: '/work', private: true })
  const privacy = tree.find(node => node.props?.label === 'Private')
  assert.equal(privacy.props.on, true)
  assert.equal(privacy.props.disabled, false)
  assert.equal(tree.find(node => node.props?.label === 'Main Bot').props.disabled, true)
  assert.equal(tree.some(node => node.props?.onClick && node.props.className === 'bt-set-row bt-bs-row' && JSON.stringify(node).includes('Duplicate')), false)
})
