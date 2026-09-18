import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import instances from '../ink/instances.js'

// Exercise the real React/Ink command screens through the revocation which
// happens synchronously inside the owner's asynchronous selection save.
const oldEnv = { ...process.env }
const originalConfig = await import('../utils/config.js')
const originalProviders = await import('../utils/model/providers.js')
const account = { accountUuid: 'control-test-account', organizationUuid: 'control-test-org' }
mock.module('../utils/config.js', () => ({ ...originalConfig, getGlobalConfig: () => ({ oauthAccount: account }) }))
mock.module('../utils/model/providers.js', () => ({ ...originalProviders, getAPIProvider: () => 'firstParty' }))
const originalBinding = await import('../utils/model/darbSessionBinding.js')
let sessionThinking: any
mock.module('../utils/model/darbSessionBinding.js', () => ({ ...originalBinding, readDarbSessionThinking: () => sessionThinking }))
const managed = await import('../utils/model/darbModels.js')
const { useDarbCatalogRevision } = await import('../hooks/useDarbCatalogRevision.js')
const id = 'Vendor/Exact'
mock.module('../hooks/useMainLoopModel.js', () => ({ useMainLoopModel: () => { useDarbCatalogRevision(); return id } }))
const originalState = await import('../state/AppState.js')
let appUpdates = 0
mock.module('../state/AppState.js', () => ({ ...originalState, useSetAppState: () => () => { appUpdates++ } }))
const { createRoot, Text } = await import('../ink.js')
let picker: any
mock.module('./CustomSelect/index.js', () => ({ Select: (props: any) => {
  picker = props
  return <Text>{props.options.map((p: any) => p.label).join(' | ')}</Text>
} }))
let saveCalls = 0
let finish: (ok: boolean) => void
mock.module('../utils/model/darbSelection.js', () => ({ selectDarbConnection: async () => {
  saveCalls++
  const scope = managed.darbModelScope()!
  const generation = managed.darbCatalogSession.begin(scope)
  await new Promise<void>((resolve, reject) => { finish = ok => {
    if (!ok) { reject(Error('owner unavailable')); return }
    managed.darbCatalogSession.complete(scope, generation, payload())
    resolve()
  } })
} }))
const { call } = await import('../commands/effort/effort.js')
const { ThinkingToggle } = await import('./ThinkingToggle.js')
const originalKeys = await import('../keybindings/useKeybinding.js')
mock.module('../keybindings/useKeybinding.js', () => ({ ...originalKeys, useKeybindings: () => {} }))
const { ModelPicker } = await import('./ModelPicker.js')
const binding = { connection_id: 'icn_' + 'a'.repeat(32), connection_revision: 1, catalog_revision: 'sha256:' + 'b'.repeat(64) }
function payload(model = id) {
  return { configuration_mode: 'custom', has_more: false,
    data: [{ ...binding, id: model, display_name: model,
      capabilities: { reasoning: true, thinking_types: ['enabled', 'adaptive'], reasoning_efforts: ['medium', 'xhigh'] } }],
    saved_selection: { ...binding, model } }
}
function install(model = id) {
  const scope = managed.darbModelScope()!
  managed.darbCatalogSession.complete(scope, managed.darbCatalogSession.begin(scope), payload(model))
}
beforeEach(() => {
  Object.assign(process.env, { DARB_CLI_MANAGED_INFERENCE: '1', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://ai.darbmind.ru', ANTHROPIC_BASE_URL: 'https://ai.darbmind.ru' })
  delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  account.accountUuid = 'control-test-account'
  saveCalls = appUpdates = 0
  sessionThinking = undefined
  picker = undefined
  install()
})
afterAll(() => {
  mock.restore()
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
  Object.assign(process.env, oldEnv)
})
class Boundary extends React.Component<{ children: React.ReactNode; caught: (error: unknown) => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) { this.props.caught(error) }
  render() { return this.state.failed ? <Text>RENDER_FAILED</Text> : this.props.children }
}

for (const screen of ['effort', 'thinking']) test(`${screen}: incompatible saved control offers explicit reset, not a render exception`, async () => {
  sessionThinking = { type: 'effort', effort: 'removed-effort' }
  expect(() => managed.darbSelectedThinking(id)).toThrow('unavailable')
  let confirmed = false
  const node = screen === 'effort' ? await call(() => { confirmed = true }, {}, '') :
    <ThinkingToggle currentValue={false} onSelect={() => { confirmed = true }} />
  const h = await harness(node)
  try {
    expect(h.errors).toEqual([])
    expect(picker.options.map((p: any) => p.value)).toEqual([screen === 'effort' ? 'auto' : 'reset'])
    void picker.onChange(picker.options[0].value)
    await until(() => saveCalls === 1)
    sessionThinking = null
    finish(true)
    await until(() => confirmed)
    expect(h.errors).toEqual([])
  } finally { await h.close() }
})

test('model picker remains closable and updates when its catalog is revoked', async () => {
  let exited = false
  const h = await harness(<ModelPicker initial={id} onSelect={() => { throw Error('must not select') }} onCancel={() => { exited = true }} />)
  try {
    expect(picker.options[0].value).toBe(id)
    managed.darbCatalogSession.begin(managed.darbModelScope()!)
    await until(() => picker.options[0]?.value === 'close' || h.errors.length > 0)
    expect(h.errors).toEqual([])
    picker.onChange('close')
    expect(exited).toBe(true)
  } finally { await h.close() }
})
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(10) }
  throw Error('render condition timed out')
}
async function harness(node: React.ReactNode) {
  const stdout: any = new PassThrough(), stdin: any = new PassThrough()
  Object.assign(stdout, { columns: 120, rows: 24, isTTY: true })
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  stdout.resume()
  const errors: unknown[] = []
  const root = await createRoot({ stdout, stdin, patchConsole: false })
  root.render(<Boundary caught={error => errors.push(error)}>{node}</Boundary>)
  await until(() => picker !== undefined || errors.length > 0)
  const nodeText = (node: any): string => node?.nodeName === '#text' ? node.nodeValue : (node?.childNodes ?? []).map(nodeText).join('')
  return { errors, text: () => nodeText((instances.get(stdout) as any)?.rootNode), close: async () => { root.unmount(); await Bun.sleep(25); stdin.end(); stdout.end() } }
}

for (const screen of ['effort', 'thinking']) {
  for (const success of [true, false]) test(`${screen}: pending save revokes authority without crashing, ${success ? 'confirmed' : 'failed'} save is bounded`, async () => {
    const done: string[] = []
    const node = screen === 'effort' ? await call(message => done.push(message ?? ''), {}, '') :
      <ThinkingToggle currentValue={false} onSelect={() => done.push('confirmed')} onCancel={() => done.push('cancel')} />
    const h = await harness(node)
    try {
      expect(h.errors).toEqual([])
      const change = picker.onChange
      void change(screen === 'effort' ? 'medium' : 'auto')
      void change(screen === 'effort' ? 'xhigh' : 'off')
      await until(() => h.text().includes('Saving') || h.errors.length > 0)
      expect(h.errors).toEqual([])
      expect(saveCalls).toBe(1)
      expect(() => managed.requireDarbModel(id)).toThrow('Connect AI')
      expect(done).toEqual([])
      finish(success)
      await until(() => success ? done.length > 0 : h.text().includes('Could not confirm'))
      expect(h.errors).toEqual([])
      if (success) {
        expect(managed.requireDarbModel(id).id).toBe(id)
        expect(done).toHaveLength(1)
      } else {
        expect(done).toEqual([])
        expect(appUpdates).toBe(0)
        expect(() => managed.requireDarbModel(id)).toThrow('Connect AI')
        expect(picker.options.map((p: any) => p.value)).toEqual(['close'])
        picker.onChange('close')
        expect(done).toHaveLength(1)
      }
    } finally { await h.close() }
  })
  for (const condition of ['refreshing', 'removed', 'account changed']) test(`${screen}: ${condition} leaves a usable exit instead of throwing`, async () => {
    if (condition === 'removed') install('Other/Model')
    if (condition === 'refreshing') managed.darbCatalogSession.begin(managed.darbModelScope()!)
    if (condition === 'account changed') account.accountUuid = 'different-account'
    let exited = false
    const node = screen === 'effort' ? await call(() => { exited = true }, {}, '') :
      <ThinkingToggle currentValue={false} onSelect={() => { throw Error('must not select') }} onCancel={() => { exited = true }} />
    const h = await harness(node)
    try {
      expect(h.errors).toEqual([])
      expect(picker.options.map((p: any) => p.value)).toEqual(['close'])
      picker.onCancel()
      expect(exited).toBe(true)
      expect(saveCalls).toBe(0)
      expect(() => managed.requireDarbModel(id)).toThrow('Connect AI')
    } finally { await h.close() }
  })
}

test('open effort screen reacts to external refresh and restored catalog without retaining execution authority', async () => {
  const h = await harness(await call(() => {}, {}, ''))
  try {
    expect(picker.options.some((p: any) => p.value === 'medium')).toBe(true)
    managed.darbCatalogSession.begin(managed.darbModelScope()!)
    await until(() => picker.options[0]?.value === 'close' || h.errors.length > 0)
    expect(h.errors).toEqual([])
    expect(() => managed.requireDarbModel(id)).toThrow('Connect AI')
    install()
    await until(() => picker.options.some((p: any) => p.value === 'medium'))
    expect(h.errors).toEqual([])
  } finally { await h.close() }
})
