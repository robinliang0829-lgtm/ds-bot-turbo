// Windows-compatible isolated bench using the installed, public DSH CLI.
// Run each server through a managed shell job; this script does not daemonize it.
//   node ds-bot/dev/turbo-smoke.mjs prepare
//   node ds-bot/dev/turbo-smoke.mjs mock       (managed background job)
//   node ds-bot/dev/turbo-smoke.mjs host       (managed background job)
//   node ds-bot/dev/turbo-smoke.mjs ready
//   node ds-bot/dev/turbo-smoke.mjs baseline
//   node ds-bot/dev/turbo-smoke.mjs controls
//   node ds-bot/dev/turbo-smoke.mjs stop-host  (then collect the host job output)
//   node ds-bot/dev/turbo-smoke.mjs host       (managed background job, restart)
//   node ds-bot/dev/turbo-smoke.mjs verify
//   node ds-bot/dev/turbo-smoke.mjs stop       (then collect both server jobs)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PLUGIN = join(ROOT, 'ds-bot')
const HOME = join(ROOT, '.dsh-test-turbo')
const DSH_DATA = join(HOME, 'runtime')
const HARNESS = join(PLUGIN, 'dev/harness')
const WEB_PORT = 3096
const MOCK_PORT = 8796
const BASE = `http://127.0.0.1:${WEB_PORT}`
const action = process.argv[2]
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const state = () => json(join(HOME, 'bot/state.json'))
const calls = () => existsSync(join(HOME, 'mock.jsonl'))
  ? readFileSync(join(HOME, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []

function environment() {
  // Do not carry the invoking desktop's profile or credentials into this bench.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(DSH_|DEEPSEEK_|ANTHROPIC_|OPENAI_|NODE_OPTIONS$)/i.test(key)))
  for (const key of Object.keys(env)) if (/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)) delete env[key]
  return { ...env, DSH_HOME: DSH_DATA, DSH_HARNESS: HARNESS,
    HOME: join(HOME, 'user'), USERPROFILE: join(HOME, 'user'),
    APPDATA: join(HOME, 'user/AppData/Roaming'), LOCALAPPDATA: join(HOME, 'user/AppData/Local'),
    PATH: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;C:\\Program Files\\PowerShell\\7` : '/usr/bin:/bin',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, DEEPSEEK_API_KEY: 'mock-key',
    MOCK_PORT: String(MOCK_PORT), MOCK_LOG: join(HOME, 'mock.jsonl'), MOCK_DELAY_MS: '300', MOCK_LOG_TOOLS: '1',
    TEMP: join(HOME, 'tmp'), TMP: join(HOME, 'tmp'), TMPDIR: join(HOME, 'tmp') }
}

async function freePort(port) {
  await new Promise((accept, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(accept))
  })
}

function junction(path, target) {
  if (existsSync(path)) {
    assert.equal(realpathSync(path).toLowerCase(), realpathSync(target).toLowerCase(), `Unexpected existing link: ${path}`)
  } else symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

function prepare() {
  assert.equal(json(join(HARNESS, 'node_modules/@deepseek-ai/dsh/package.json')).version, '0.2.2-rc.1')
  const profile = join(DSH_DATA, 'profiles/web')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  for (const name of ['bot', 'sessions']) {
    mkdirSync(join(DSH_DATA, name), { recursive: true })
    junction(join(HOME, name), join(DSH_DATA, name))
  }
  mkdirSync(join(HOME, 'tmp'), { recursive: true })
  mkdirSync(join(HOME, 'user/AppData/Roaming'), { recursive: true })
  mkdirSync(join(HOME, 'user/AppData/Local'), { recursive: true })
  junction(join(profile, 'node_modules/ds-bot'), PLUGIN)
  junction(join(profile, 'node_modules/@deepseek-ai'), join(HARNESS, 'node_modules/@deepseek-ai'))
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-turbo-smoke', private: true,
    dependencies: { 'ds-bot': `link:${PLUGIN.replaceAll('\\', '/')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'] } },
  }, null, 2)}\n`)
  writeFileSync(join(HOME, 'bench.patch.yml'), [
    '- id: bot', '  config:', '    checkRatio: 0.45',
    '- id: llm-deepseek', '  config:', '    models:',
    '      - { id: deepseek-flash, contextWindow: 100000, maxTokens: 8000, inputModalities: [text, image] }',
    '      - { id: deepseek-v4-pro, contextWindow: 100000, maxTokens: 8000 }', '',
  ].join('\n'))
  console.log('Prepared isolated .dsh-test-turbo profile; existing Bot and Session state preserved.')
}

async function runNode(args, log) {
  const fd = log ? openSync(join(HOME, log), 'a') : undefined
  const child = spawn(process.execPath, args, {
    cwd: ROOT, env: environment(), stdio: log ? ['ignore', fd, fd] : 'inherit',
  })
  const started = Date.now()
  let stopping = false
  const stop = () => { stopping = true; child.kill('SIGTERM') }
  const stopFile = log ? join(HOME, `${log}.stop`) : undefined
  const stopWatcher = stopFile ? setInterval(() => {
    if (existsSync(stopFile) && statSync(stopFile).mtimeMs >= started) stop()
  }, 500) : undefined
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const code = await new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('exit', (value, signal) => accept(stopping ? 0 : signal ? 1 : value ?? 1))
  })
  if (stopWatcher) clearInterval(stopWatcher)
  process.exitCode = code
}

async function login() {
  // Read ephemeral bench authentication only in memory; never print it.
  const log = readFileSync(join(HOME, 'web.log'), 'utf8')
  const urls = [...log.matchAll(new RegExp(`http://127\\.0\\.0\\.1:${WEB_PORT}/\\?token=[^\\s]+`, 'g'))]
  assert.ok(urls.length, 'Host has not emitted its login URL')
  const response = await fetch(urls.at(-1)[0], { redirect: 'manual' })
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, `Login did not set a cookie (${response.status})`)
  return cookie
}

async function ready() {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const cookie = await login()
      const response = await fetch(BASE, { headers: { cookie } })
      const html = await response.text()
      assert.equal(response.status, 200)
      assert.ok(html.includes('__DSH_BOOT__'), 'The response is not the bootstrapped DSH web app')
      const mock = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`)
      assert.equal(mock.status, 200)
      console.log(`Host and mock ready: web ${WEB_PORT}, mock ${MOCK_PORT}; authenticated DSH HTML verified.`)
      return
    } catch { await sleep(500) }
  }
  throw new Error('Bench readiness timed out; inspect ignored web.log locally without exposing authentication values.')
}

async function botApi() {
  const cookie = await login()
  return async function api(endpoint, payload = {}, expectFailure = false) {
    const response = await fetch(`${BASE}/api/bot`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint, payload }),
    })
    const result = await response.json()
    if (expectFailure) { assert.equal(result.ok, false, `${endpoint} unexpectedly succeeded`); return result.error }
    assert.equal(result.ok, true, `${endpoint}: ${result.error?.message ?? 'failed'}`)
    return result.value
  }
}

async function controls() {
  const api = await botApi()
  async function settle() {
    const deadline = Date.now() + 90_000
    let count = calls().length
    let quiet = Date.now()
    while (Date.now() < deadline) {
      await sleep(250)
      const current = await api('state')
      const next = calls().length
      if (next !== count || Object.keys(current.activity ?? {}).length) { count = next; quiet = Date.now() }
      else if (Date.now() - quiet > 1500) return
    }
    throw new Error('The team did not settle')
  }
  const results = []
  async function check(name, test) {
    await test()
    results.push(name)
    console.log(`ok   ${name}`)
  }
  const models = (await api('state')).models
  const model = models?.find(entry => entry.ref === 'deepseek-official/deepseek-v4-pro')?.ref
  assert.ok(model, 'The pinned mock-backed model is unavailable')
  const bot = Object.values(state().bots).find(entry => entry.name === 'Turbo Probe')
    ?? await api('create-bot', { name: 'Turbo Probe', role: 'QA', instructions: 'Exercise the isolated smoke bench.', model })
  await settle()
  const saved = () => state().bots[bot.id]
  async function update(patch) { await api('update-bot', { id: bot.id, ...patch }); await settle() }
  async function probe(text, sessionId = bot.id) {
    const before = calls().length
    await api('send', { sessionId, text })
    await settle()
    const observed = calls().slice(before)
    assert.ok(observed.length > 0, 'No real host-to-mock model request was recorded')
    return observed
  }
  const offered = entries => entries.flatMap(entry => entry.toolNames ?? [])
  const used = (entries, name) => entries.some(entry => entry.out?.some(block => block.type === 'tool_use' && block.name === name))
  const denied = (entries, name) => entries.some(entry => entry.out?.some(block => block.type === 'text' && block.text.includes(`Tool ${name} is disabled for`)))
  const echoLog = join(HOME, 'echo-calls.jsonl')
  const echoes = () => existsSync(echoLog) ? readFileSync(echoLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const observer = join(HOME, `observe-echo-${Date.now()}.mjs`)
  const echoSource = readFileSync(join(PLUGIN, 'dev/mcp-echo-server.mjs'), 'utf8')
  assert.ok(echoSource.includes("case 'tools/call':"), 'The fixture instrumentation point changed')
  writeFileSync(observer, `// Instrumented copy of this repository's MCP echo test fixture.\nimport { appendFileSync } from 'node:fs'\n${echoSource.replace("case 'tools/call':", `case 'tools/call':\n      appendFileSync(${JSON.stringify(echoLog)}, JSON.stringify(request.params) + '\\n')`)}`)
  let room
  let duplicate
  try {
    await check('native allow list persists and permits an actual tool execution', async () => {
      await update({ toolScope: { allow: ['native:list_bots'] }, modelFallback: false })
      assert.deepEqual(saved().toolScope, { allow: ['native:list_bots'] })
      assert.equal(saved().modelFallback, false)
      const observed = await probe('调用 list_bots {}')
      assert.ok(used(observed, 'list_bots'))
      assert.ok(!denied(observed, 'list_bots'))
    })
    await check('deny wins over allow and refuses an actual tool call', async () => {
      await update({ toolScope: { allow: ['native:*'], deny: ['native:list_bots'] } })
      const observed = await probe('调用 list_bots {}')
      assert.ok(used(observed, 'list_bots'), 'The mock must attempt the denied call')
      assert.ok(denied(observed, 'list_bots'), 'The real host must return the policy refusal')
    })
    await check('empty allow list refuses an actual native call', async () => {
      await update({ toolScope: { allow: [] } })
      const observed = await probe('调用 list_bots {}')
      assert.ok(used(observed, 'list_bots'))
      assert.ok(denied(observed, 'list_bots'))
    })
    await check('invalid selectors are rejected without partially changing the Bot', async () => {
      const before = JSON.stringify(saved())
      await api('update-bot', { id: bot.id, role: 'Unexpected', toolScope: { allow: ['bad:*'] } }, true)
      assert.equal(JSON.stringify(saved()), before)
      await api('update-bot', { id: bot.id, modelFallback: 'false' }, true)
      assert.equal(JSON.stringify(saved()), before)
    })
    await check('clearing Tool access restores normal execution', async () => {
      await update({ toolScope: null })
      assert.equal(saved().toolScope, undefined)
      const observed = await probe('调用 list_bots {}')
      assert.ok(used(observed, 'list_bots'))
      assert.ok(!denied(observed, 'list_bots'))
    })
    await api('capability-save', { name: 'turbo-echo', kind: 'mcp', description: 'Isolated Turbo smoke echo', transport: 'stdio', command: process.execPath, args: [observer], env: {} })
    await check('allowing an unattached MCP server does not grant its tools', async () => {
      await api('bot-capability', { botId: bot.id, name: 'turbo-echo', attached: false })
      await update({ toolScope: { allow: ['mcp:turbo-echo:*'] } })
      assert.ok(!offered(await probe('查能力 turbo')).includes('mcp__turbo-echo__echo'))
    })
    await check('attached MCP allow list permits a call to the real echo server', async () => {
      await api('bot-capability', { botId: bot.id, name: 'turbo-echo', attached: true })
      const before = echoes().length
      const observed = await probe('调用 mcp__turbo-echo__echo {"text":"turbo live echo"}')
      assert.ok(used(observed, 'mcp__turbo-echo__echo'))
      assert.equal(echoes().length, before + 1)
      assert.equal(echoes().at(-1).arguments.text, 'turbo live echo')
    })
    await check('MCP deny blocks an attempted call before it reaches the server', async () => {
      await update({ toolScope: { allow: ['mcp:turbo-echo:*'], deny: ['mcp:turbo-echo:echo'] } })
      const before = echoes().length
      const observed = await probe('调用 mcp__turbo-echo__echo {"text":"must not run"}')
      assert.ok(used(observed, 'mcp__turbo-echo__echo'), 'The mock must attempt the denied MCP call')
      assert.equal(echoes().length, before, 'The denied MCP call reached the server')
    })
    await check('group turns use the same Bot tool restrictions', async () => {
      await update({ toolScope: { allow: ['native:recall'] } })
      const peer = Object.values(state().bots).find(entry => entry.id !== bot.id)
      assert.ok(peer, 'Group check requires the baseline team')
      room = await api('create-room', { name: 'Turbo restricted group', members: [bot.id, peer.id], admin: bot.id })
      await settle()
      const allowed = await probe('回忆', room.id)
      assert.ok(used(allowed, 'recall'))
      assert.ok(!denied(allowed, 'recall'))
      await update({ toolScope: { allow: [] } })
      const refused = await probe('回忆', room.id)
      assert.ok(used(refused, 'recall'))
      assert.ok(denied(refused, 'recall'))
      await update({ toolScope: { allow: ['native:list_bots'] } })
    })
    await check('duplicated Bots preserve tool selection and fixed-model policy', async () => {
      duplicate = await api('duplicate-bot', { id: bot.id })
      await settle()
      const copy = state().bots[duplicate.id]
      assert.deepEqual(copy.toolScope, saved().toolScope)
      assert.equal(copy.modelFallback, false)
      assert.equal(copy.model, saved().model)
    })
    await check('fixed model remains selected through tool and group requests', async () => {
      assert.equal(saved().model, model)
      assert.equal(saved().appliedModel, saved().model)
      assert.equal(saved().modelFallback, false)
    })
    writeFileSync(join(HOME, 'turbo-controls-results.json'), `${JSON.stringify({ passed: results, botId: bot.id, model: saved().model, ports: { web: WEB_PORT, mock: MOCK_PORT } }, null, 2)}\n`)
    console.log(`\nTurbo controls: all ${results.length} checks passed. Probe retained for browser/restart verification.`)
  } finally {
    if (room) await api('delete-room', { id: room.id })
    if (duplicate) await api('delete-bot', { id: duplicate.id })
  }
}

async function persistence() {
  const previous = json(join(HOME, 'turbo-controls-results.json'))
  const api = await botApi()
  await api('state')
  const bot = state().bots[previous.botId]
  assert.ok(bot, 'The prior probe Bot did not survive restart')
  assert.deepEqual(bot.toolScope, { allow: ['native:list_bots'] })
  assert.equal(bot.modelFallback, false)
  assert.equal(bot.model, previous.model)
  async function request(tool, expectedDenied) {
    const before = calls().length
    await api('send', { sessionId: bot.id, text: `调用 ${tool} {}` })
    const deadline = Date.now() + 90_000
    let count = before
    let quiet = Date.now()
    while (Date.now() < deadline) {
      await sleep(250)
      const value = await api('state')
      const observed = calls().slice(before)
      if (calls().length !== count || Object.keys(value.activity ?? {}).length) { count = calls().length; quiet = Date.now() }
      else if (observed.length && Date.now() - quiet > 1500) {
        assert.ok(observed.some(entry => entry.out?.some(block => block.type === 'tool_use' && block.name === tool)))
        assert.equal(observed.some(entry => entry.out?.some(block => block.type === 'text' && block.text.includes(`Tool ${tool} is disabled for`))), expectedDenied)
        return
      }
    }
    throw new Error('Restart probe did not complete a model request')
  }
  await request('list_bots', false)
  await request('recall', true)
  writeFileSync(join(HOME, 'turbo-restart-results.json'), `${JSON.stringify({ passed: ['toolScope and fixed model survive restart', 'restarted host permits the saved allowed tool', 'restarted host refuses a tool outside saved allow list'], botId: bot.id, model: bot.model }, null, 2)}\n`)
  console.log('ok   saved Tool access and fixed model survive restart; allowed and refused executions verified')
}

async function unavailableModel() {
  const previous = json(join(HOME, 'turbo-controls-results.json'))
  const api = await botApi()
  const value = await api('state')
  assert.ok(value.models.some(model => model.ref === 'deepseek-official/deepseek-flash'))
  assert.ok(!value.models.some(model => model.ref === previous.model), 'Start host-unavailable before this check')
  const before = calls().length
  const started = Date.now()
  await api('send', { sessionId: previous.botId, text: 'The pinned model is intentionally absent.' })
  let failure
  while (Date.now() - started < 30_000) {
    await sleep(250)
    const report = await api('diagnostics')
    failure = report.entries.find(entry => entry.source === 'turn' && entry.time >= started && /fixed model connection .* is unavailable/i.test(entry.text))
    if (failure) break
  }
  assert.ok(failure, 'The refused model turn did not produce its expected diagnostic')
  await sleep(2000)
  assert.equal(calls().length, before, 'The missing fixed model sent a fallback request')
  const bot = state().bots[previous.botId]
  assert.equal(bot.model, previous.model)
  assert.equal(bot.appliedModel, previous.model)
  assert.equal(bot.modelFallback, false)
  writeFileSync(join(HOME, 'turbo-unavailable-results.json'), `${JSON.stringify({ passed: ['missing fixed model refuses the turn with a clear error', 'no fallback request reaches the available mock model', 'saved and applied model selections are unchanged'], botId: bot.id, model: bot.model, error: failure.text }, null, 2)}\n`)
  console.log('ok   missing fixed model refuses the turn without calling the remaining provider model')
}

try {
  if (action === 'prepare') prepare()
  else if (action === 'stop' || action === 'stop-host') {
    writeFileSync(join(HOME, 'web.log.stop'), String(Date.now()))
    if (action === 'stop') writeFileSync(join(HOME, 'mock.out.stop'), String(Date.now()))
    console.log('Requested isolated server shutdown; collect managed job output to confirm exit.')
  }
  else if (action === 'reset') {
    await freePort(WEB_PORT)
    await freePort(MOCK_PORT)
    const archive = join(HOME, 'history', String(Date.now()))
    mkdirSync(archive, { recursive: true })
    for (const name of ['runtime', 'bot', 'sessions', 'mock.jsonl', 'web.log', 'mock.out', 'smoke-transcript.json']) {
      const source = join(HOME, name)
      assert.ok(source.startsWith(`${HOME}\\`) || source.startsWith(`${HOME}/`))
      if (existsSync(source)) renameSync(source, join(archive, name))
    }
    prepare()
    console.log('Archived previous isolated test data; a fresh baseline is ready.')
  }
  else if (action === 'mock') {
    await freePort(MOCK_PORT)
    await runNode([join(PLUGIN, 'dev/mock-llm.mjs')], 'mock.out')
  } else if (action === 'host' || action === 'host-unavailable') {
    await freePort(WEB_PORT)
    let patch = join(HOME, 'bench.patch.yml')
    if (action === 'host-unavailable') {
      patch = join(HOME, 'bench-unavailable.patch.yml')
      const full = readFileSync(join(HOME, 'bench.patch.yml'), 'utf8')
      writeFileSync(patch, full.split('\n').filter(line => !line.includes('id: deepseek-v4-pro')).join('\n'))
    }
    await runNode(['--import', pathToFileURL(join(PLUGIN, 'test/harness-resolve.mjs')).href, join(HARNESS, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patch, '--no-open', '--port', String(WEB_PORT)], 'web.log')
  } else if (action === 'ready') await ready()
  else if (action === 'baseline') {
    const bots = Object.values(state().bots)
    assert.ok(bots.length <= 1 && bots.every(bot => !bot.model), 'Baseline smoke requires a fresh bench')
    const cookie = await login()
    const response = await fetch(`${BASE}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint: 'state', payload: {} }) })
    const result = await response.json()
    assert.equal(result.ok, true)
    assert.ok(result.value.models.length > 0 && result.value.models.every(model => model.ref.startsWith('deepseek-official/')), 'Baseline would select a non-mock provider')
    await runNode([join(PLUGIN, 'dev/smoke.mjs'), 'turbo', String(WEB_PORT), '--out', join(HOME, 'smoke-transcript.json')])
  } else if (action === 'controls') await controls()
  else if (action === 'verify') await persistence()
  else if (action === 'verify-unavailable') await unavailableModel()
  else if (action === 'inspect') {
    const cookie = await login()
    const response = await fetch(`${BASE}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint: 'state', payload: {} }) })
    const result = await response.json()
    assert.equal(result.ok, true)
    console.log(JSON.stringify({ models: result.value.models.map(({ ref, needsKey }) => ({ ref, needsKey })), bots: Object.values(state().bots).map(({ name, model, appliedModel, greetingPending, blocked }) => ({ name, model, appliedModel, greetingPending, blocked })), modelCalls: calls().length, recentRequests: calls().slice(-8).map(entry => ({ session: entry.session, tools: entry.toolNames?.length, calls: entry.out?.filter(block => block.type === 'tool_use').map(block => block.name) })) }, null, 2))
  }
  else throw new Error('Use prepare, reset, mock, host, host-unavailable, ready, baseline, controls, verify, verify-unavailable, inspect, stop-host, or stop')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
