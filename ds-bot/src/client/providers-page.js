// The Models page of a window that has no DSH settings of its own: the model providers
// DSH serves, with their API keys and models, and the providers it can add. DSH keeps
// all of it; a key only ever travels from these inputs to the host.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { MAGPIE } from '../shared/magpie.js'
import { CheckIcon, TrashIcon } from './icons.js'
import { KeyIcon, MaskedInput } from './secret-card.js'
import { Segmented, SPRING_SHAPE } from './motion.js'
import { hostText, t } from './i18n.js'

const PROTOCOL_NAMES = { 'openai-completions': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages' }
// Anthropic's SDK appends /v1/messages itself; the OpenAI ones take the /v1 root.
const ENDPOINT_HINTS = { 'anthropic-messages': 'https://gateway.example' }
const SHOWN_MODELS = 8

// A failure in the interface language; the dialog's error line shows it.
const translated = promise => Promise.resolve(promise).catch((failure) => { throw new Error(hostText(failure?.message ?? String(failure))) })

export function ProvidersPage({ actions, run, Section }) {
  const [view, setView] = useState(null)
  const [open, setOpen] = useState(null)
  const [adding, setAdding] = useState(false)
  // Resolves true when the host took it; the page then shows the host's new view.
  const apply = promise => run(translated(promise).then((next) => { if (next?.providers) setView(next) }))
  useEffect(() => { void apply(actions.providers()) }, [])
  if (view === null) return null
  if (!view.available) return h('p', { className: 'bt-set-hint' }, t('This DSH cannot set up model providers.'))
  return [
    h(Section, { key: 'list', title: t('Model providers · {count}', { count: view.providers.length }) },
      view.providers.map(provider => h(ProviderRow, {
        key: provider.id, provider, apply, actions,
        open: open === provider.id, onToggle: () => setOpen(open === provider.id ? null : provider.id),
      })),
      adding ? h(AddProvider, { key: 'add', view, apply, actions, initialMode: adding, onDone: () => setAdding(false) }) : null),
    adding ? null : h('div', { key: 'add', className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setAdding('magpie') }, t('Connect Magpie')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setAdding(view.addable.length > 0 ? 'known' : 'custom') }, t('Add a provider'))),
  ]
}

function keyState(key) {
  if (key === null) return null
  if (!key.configured) return ['missing', t('Needs an API key')]
  return key.writable ? ['set', t('Key set')] : ['outside', t('Key set outside DS Bot')]
}

function ProviderRow({ provider, apply, actions, open, onToggle }) {
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { if (!open) setConfirm(false) }, [open])
  const state = keyState(provider.key)
  const shown = provider.models.slice(0, SHOWN_MODELS)
  const hint = provider.error ?? (provider.models.length === 0 ? t('No models') : t('{count} models', { count: provider.models.length }))
  return h('div', { className: 'bt-secret-item bt-provider', 'data-open': open ? '' : undefined },
    h('button', { type: 'button', className: 'bt-set-row bt-secret-summary', 'aria-expanded': open, onClick: onToggle },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-secret-title' }, provider.name, provider.name !== provider.id ? h('span', { className: 'bt-provider-id' }, provider.id) : null),
        h('span', { className: 'bt-set-hint', 'data-error': provider.error ? '' : undefined }, hint)),
      state ? h('span', { className: 'bt-set-control' }, h('span', { className: 'bt-provider-state', 'data-state': state[0] }, state[1])) : null),
    open ? h('div', { className: 'bt-secret-edit' },
      provider.key?.writable ? h(KeyEditor, { provider, apply, actions }) : null,
      provider.key && !provider.key.writable ? h('div', { className: 'bt-set-hint' }, t('This key comes from outside DS Bot, such as an environment variable, and cannot be changed here.')) : null,
      provider.models.length > 0 ? h('div', { className: 'bt-secret-edit-block' },
        h('div', { className: 'bt-secret-edit-label' }, t('Models')),
        h('div', { className: 'bt-provider-models' },
          shown.map(model => h('span', { key: model.ref, className: 'bt-tag', title: model.ref }, model.name)),
          provider.models.length > shown.length ? h('span', { className: 'bt-set-hint' }, t('and {count} more', { count: provider.models.length - shown.length })) : null)) : null,
      provider.removable ? h('div', { className: 'bt-secret-row-actions' },
        confirm
          ? [
              h('span', { key: 'q', className: 'bt-set-hint' }, t('Remove {name}? Bots on its models need another model.', { name: provider.name })),
              h('button', { key: 'no', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirm(false) }, t('Keep')),
              h('button', { key: 'yes', type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => apply(actions.removeProvider(provider.id)) }, t('Remove')),
            ]
          : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => setConfirm(true) }, h(TrashIcon), t('Remove provider'))) : null) : null)
}

function KeyEditor({ provider, apply, actions }) {
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  const ready = value.trim() !== ''
  const save = () => {
    if (!ready) return
    void apply(actions.setProviderKey(provider.id, value)).then((ok) => { if (ok) { setValue(''); setSaved(true) } })
  }
  const edit = (next) => { setValue(next); setSaved(false) }
  const label = t('{provider} API key', { provider: provider.name })
  return h('div', { className: 'bt-secret-edit-block' },
    h('div', { className: 'bt-secret-edit-label' }, provider.key.configured ? t('Replace the API key') : t('API key')),
    h('div', { className: 'bt-secret-inline' },
      h('label', { className: 'bt-q-field bt-secret-field' }, h(KeyIcon), h(MaskedInput, { value, onChange: edit, onEnter: save, label })),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !ready, onClick: save }, t('Save')),
      provider.key.configured ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => apply(actions.setProviderKey(provider.id, null)) }, t('Remove key')) : null),
    saved ? h('div', { className: 'bt-set-hint bt-secret-ok', role: 'status' }, h(CheckIcon), t('Saved.')) : null)
}

function AddProvider({ view, apply, actions, onDone, initialMode }) {
  const [mode, setMode] = useState(initialMode)
  return h('div', { className: 'bt-set-row bt-set-paste bt-provider-add' },
    h(Segmented, { label: t('Kind of provider'), value: mode },
      [['magpie', MAGPIE.name], ['known', t('Known provider')], ['custom', t('Custom API')]].map(([id, label]) => h('button', {
        key: id, type: 'button', 'aria-pressed': mode === id, disabled: id === 'known' && view.addable.length === 0, onClick: () => setMode(id),
      }, label))),
    // The forms stay mounted, so switching keeps each connection draft.
    h('div', { hidden: mode !== 'magpie' }, h(CustomForm, { view, apply, actions, onDone, preset: MAGPIE })),
    h('div', { hidden: mode !== 'known' }, h(KnownForm, { view, apply, actions, onDone })),
    h('div', { hidden: mode !== 'custom' }, h(CustomForm, { view, apply, actions, onDone })))
}

function KnownForm({ view, apply, actions, onDone }) {
  const [provider, setProvider] = useState('')
  const [key, setKey] = useState('')
  const options = [...view.addable].sort((a, b) => a.name.localeCompare(b.name))
  const add = () => {
    if (provider === '') return
    void apply(actions.addProvider({ provider, key })).then((ok) => { if (ok) onDone() })
  }
  return h('div', { className: 'bt-provider-form' },
    h('select', { className: 'bt-select', 'aria-label': t('Provider'), value: provider, onChange: event => setProvider(event.target.value) },
      h('option', { value: '', disabled: true }, t('Choose a provider')),
      options.map(option => h('option', { key: option.id, value: option.id }, option.name))),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(KeyIcon), h(MaskedInput, { value: key, onChange: setKey, onEnter: add, label: t('API key') })),
    h(FormActions, { onCancel: onDone, onAdd: add, ready: provider !== '' }))
}

function CustomForm({ view, apply, actions, onDone, preset }) {
  const [draft, setDraft] = useState({ provider: '', name: preset?.name ?? '', baseURL: preset?.baseURL ?? '', api: preset?.api ?? view.protocols[0], key: '', typed: '' })
  const [found, setFound] = useState(null)
  const [picked, setPicked] = useState([])
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const saving = useRef(false)
  useEffect(() => () => { request.current += 1 }, [])
  const set = (field, value) => {
    if (['baseURL', 'api', 'key'].includes(field)) {
      request.current += 1
      setFound(null)
      setPicked([])
      setAsking(false)
    }
    setDraft(current => ({ ...current, [field]: value }))
  }
  const typed = [...new Set(draft.typed.split(/[\s,]+/).map(id => id.trim()).filter(Boolean))]
  const models = [...(found ?? []).filter(model => picked.includes(model.id)), ...typed.filter(id => !picked.includes(id)).map(id => ({ id }))]
  const ready = (preset || draft.provider.trim() !== '') && draft.baseURL.trim() !== '' && models.length > 0 && !busy
  const fetchModels = () => {
    const current = ++request.current
    setAsking(true)
    void apply(Promise.resolve().then(() => actions.providerModels({ ...(preset ? { preset: preset.id } : {}), baseURL: draft.baseURL, api: draft.api, key: draft.key })).then((list) => {
      if (current === request.current) { setFound(list); setPicked([]) }
    }).catch((error) => { if (current === request.current) throw error })).finally(() => { if (current === request.current) setAsking(false) })
  }
  const toggle = id => setPicked(list => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]))
  const add = () => {
    if (!ready || saving.current) return
    saving.current = true
    setBusy(true)
    void apply(Promise.resolve().then(() => actions.addProvider({ custom: true, ...(preset ? { preset: preset.id } : { provider: draft.provider.trim() }), name: draft.name, baseURL: draft.baseURL, api: draft.api, key: draft.key, models })))
      .then((ok) => { if (ok) onDone() })
      .finally(() => { saving.current = false; setBusy(false) })
  }
  const input = (field, label, placeholder) => h('input', {
    className: 'bt-input', 'aria-label': label, placeholder, value: draft[field], spellCheck: false, autoComplete: 'off', disabled: busy, onChange: event => set(field, event.target.value),
  })
  return h('div', { className: 'bt-provider-form' },
    preset ? h('div', { className: 'bt-set-hint' }, t('Each Magpie connection has its own model route and API key.')) : null,
    preset ? input('name', t('Connection name'), t('Name (optional)')) : h('div', { className: 'bt-provider-pair' },
      input('provider', t('Provider ID'), t('Provider ID, e.g. my-gateway')),
      input('name', t('Name'), t('Name (optional)'))),
    h('div', { className: 'bt-provider-pair' },
      input('baseURL', t('Endpoint'), preset?.baseURL ?? ENDPOINT_HINTS[draft.api] ?? 'https://gateway.example/v1'),
      h('select', { className: 'bt-select', 'aria-label': t('Protocol'), value: draft.api, disabled: busy, onChange: event => set('api', event.target.value) },
        (preset?.protocols ?? view.protocols).map(api => h('option', { key: api, value: api }, PROTOCOL_NAMES[api] ?? api)))),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(KeyIcon), h(MaskedInput, { value: draft.key, onChange: value => set('key', value), label: t('API key'), disabled: busy })),
    preset ? h('div', { className: 'bt-set-hint' }, t('Local Magpie may leave the key blank. Choose the protocol your model serves.')) : null,
    h('div', { className: 'bt-secret-edit-block' },
      h('div', { className: 'bt-provider-models-head' },
        h('span', { className: 'bt-secret-edit-label' }, t('Models')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: asking || busy || draft.baseURL.trim() === '', onClick: fetchModels }, asking ? t('Asking…') : t('Fetch models'))),
      found !== null && found.length === 0 ? h('div', { className: 'bt-set-hint' }, t('The endpoint lists no models. Enter their ids below.')) : null,
      found !== null && found.length > 0 ? h('div', { className: 'bt-secret-bots bt-provider-found' }, found.map(model => h('button', {
        key: model.id, type: 'button', className: 'bt-secret-bot', disabled: busy, 'aria-pressed': picked.includes(model.id), title: [model.name, ...(model.nativeApis ?? []).map(api => PROTOCOL_NAMES[api])].filter(Boolean).join(' · ') || undefined, onClick: () => toggle(model.id),
      }, h('code', null, model.id), picked.includes(model.id) ? h(CheckIcon) : null))) : null,
      input('typed', t('Model ids'), t('Model ids, separated by commas'))),
    h(FormActions, { onCancel: onDone, onAdd: add, ready, busy }))
}

function FormActions({ onCancel, onAdd, ready, busy = false }) {
  return h('div', { className: 'bt-secret-row-actions' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onCancel }, t('Cancel')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !ready, onClick: onAdd }, busy ? t('Adding…') : t('Add')))
}

export const PROVIDERS_CSS = `
.bt-provider-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--bt-ink-3)}
.bt-provider .bt-set-hint[data-error]{color:var(--bt-danger)}
.bt-provider-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--bt-ink-2);white-space:nowrap}
.bt-provider-state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--bt-ink-3)}
.bt-provider-state[data-state=set]::before{background:var(--bt-green)}
.bt-provider-state[data-state=missing]{color:var(--bt-danger)}
.bt-provider-state[data-state=missing]::before{background:var(--bt-danger)}
.bt-provider .bt-secret-field{align-items:center;gap:8px}
.bt-provider .bt-secret-field>svg,.bt-provider-form .bt-secret-field>svg{flex:none;color:var(--bt-ink-3)}
.bt-provider-models{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.bt-provider-models .bt-tag{max-width:220px}
.bt-provider-add{gap:12px;animation:bt-q-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .2s ease-out backwards}
.bt-provider-add .bt-seg{align-self:flex-start}
.bt-provider-add .bt-seg button{flex:none;padding:0 14px;white-space:nowrap}
.bt-provider-add .bt-seg button:disabled{opacity:.45;cursor:default}
.bt-provider-form{display:flex;flex-direction:column;gap:10px}
.bt-provider-form .bt-secret-field{min-height:36px;align-items:center;gap:8px}
.bt-provider-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bt-provider-models-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
/* Room for the pills' focus rings inside the scroll box; the margin keeps them in line with the fields. */
.bt-provider-found{max-height:180px;overflow-y:auto;scrollbar-width:thin;padding:3px;margin:-3px}
.bt-provider-found code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.bt-provider-found .bt-secret-bot{padding:0 10px}
@media (prefers-reduced-motion:reduce){.bt-provider-add{animation:none}}
`
