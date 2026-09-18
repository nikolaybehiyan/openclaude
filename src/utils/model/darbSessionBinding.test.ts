import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asSessionId } from '../../types/ids.js'
import { getSessionId, switchSession } from '../../bootstrap/state.js'
import { guardDarbFetch, type DarbModelBinding } from './darbCatalog.js'
import { darbModelForResume, isDarbMainConversationSource, makeDarbDefaultSessionBinding, makeDarbSessionBinding, parseDarbSessionBinding, readDarbSessionThinking } from './darbSessionBinding.js'

const originalManaged = await import('./darbModels.js')
let managed = true
mock.module('./darbModels.js', () => ({ ...originalManaged, isDarbManagedInference: () => managed }))
const storage = await import('../sessionStorage.js')
const { loadMessagesFromJsonlPath } = await import('../conversationRecovery.js')
const oldEnv = { ...process.env }
const oldSessionId = getSessionId()
const dirs: string[] = []
let file: string
const sid = '00000000-0000-4000-8000-000000000999'
const scope = JSON.stringify(['https://ai.darbmind.ru', 'account-A', 'org-A'])
const model: DarbModelBinding = { id: 'Vendor/real-model', display_name: 'Real model',
  connection_id: 'icn_' + 'a'.repeat(32), connection_revision: 3,
  catalog_revision: 'sha256:' + 'b'.repeat(64), reasoning: true, reasoning_efforts: ['medium'],
  reasoning_support: 'supported', effort_support: 'supported', thinking_types: ['enabled'],
  supports_1m: false, context_window_tokens: 0 }
const binding = makeDarbSessionBinding(scope, model)

function message(content = 'Synthetic resume test') {
  return { type: 'user', sessionId: sid, uuid: '00000000-0000-4000-8000-000000000001', parentUuid: null,
    timestamp: '2026-09-14T12:00:00.000Z', cwd: '/tmp', userType: 'external', version: 'test',
    isSidechain: false, message: { role: 'user', content } }
}
const entry = (value: unknown) => ({ type: 'darb-inference-binding', sessionId: sid, binding: value })
async function fixture(entries: unknown[]) {
  await writeFile(file, entries.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
}

beforeEach(async () => {
  managed = true
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  const dir = await mkdtemp(join(tmpdir(), 'darb-session-binding-'))
  dirs.push(dir)
  file = join(dir, sid + '.jsonl')
  switchSession(asSessionId(sid), dir)
  storage.resetProjectForTesting()
  storage.setSessionFileForTesting(file)
  await fixture([message()])
})
afterEach(async () => {
  storage.resetProjectForTesting()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
afterAll(() => {
  switchSession(oldSessionId)
  mock.restore()
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
  Object.assign(process.env, oldEnv)
})

test('persists only a versioned scope hash and connection selector, not keys/endpoints/model capabilities', () => {
  const parsed = parseDarbSessionBinding({ ...binding, token: 'do-not-persist', endpoint: 'https://private.example' })
  expect(parsed).toEqual(binding)
  expect(JSON.stringify(parsed)).not.toContain('account-A')
  expect(JSON.stringify(parsed)).not.toContain('do-not-persist')
  expect(parseDarbSessionBinding({ ...binding, version: 99 })).toBeNull()
  expect(parseDarbSessionBinding({ ...binding, connection_revision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull()
})

test('main model preference survives disk, fork, controls and helper requests without becoming authorization', async () => {
  storage.bindDarbSessionConnection(binding)
  storage.setDarbSessionModel(binding, model.id)
  storage.setDarbSessionThinking(binding, model.id, {type: 'mode', mode: 'extended'})
  const saved = await storage.loadTranscriptFromFile(file)
  expect(saved.darbInferenceBinding?.version === 1 && saved.darbInferenceBinding.selected_model).toBe(model.id)
  storage.resetProjectForTesting()
  storage.setSessionFileForTesting(file)
  storage.restoreSessionMetadata(saved)
  const helper = makeDarbSessionBinding(scope, {...model, id: 'different-helper'})
  storage.bindDarbSessionConnection(helper)
  storage.bindDarbSessionConnection({...binding, controls_by_model: [{model: model.id, thinking: null}]}, true)
  const restored = (await storage.loadTranscriptFromFile(file)).darbInferenceBinding
  expect(darbModelForResume(restored, true, undefined)).toBe(model.id)
  expect(darbModelForResume(restored, true, 'explicit-override')).toBeUndefined()
  expect(darbModelForResume(restored, false, undefined)).toBeUndefined()
  expect(darbModelForResume(binding, true, undefined)).toBeUndefined()
  expect(() => storage.setDarbSessionModel({...binding, connection_revision: 4}, model.id)).toThrow('No history was sent')
  for (const selected_model of ['', ' padded ', 'bad\nmodel', 'x'.repeat(513), 7]) {
    expect(parseDarbSessionBinding({...binding, selected_model})).toBeNull()
  }
  storage.clearSessionMetadata()
  expect(() => storage.setDarbSessionModel(binding, model.id)).toThrow('No history was sent')
})

test('only main conversation requests persist the model, never compaction or child agents', () => {
  for (const source of ['sdk', 'repl_main_thread', 'repl_main_thread:custom']) expect(isDarbMainConversationSource(source)).toBe(true)
  for (const source of ['agent:general-purpose', 'compact', 'session_memory', 'title', undefined]) expect(isDarbMainConversationSource(source)).toBe(false)
})

test('durable metadata survives all native log loading paths and permits another approved model on the same connection', async () => {
  storage.bindDarbSessionConnection(binding)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  const full = await storage.loadTranscriptFromFile(file)
  const lite = await storage.loadFullLog({ ...full, messages: [], sessionId: sid })
  const byId = await storage.getLastSessionLog(sid)
  const byPath = await loadMessagesFromJsonlPath(file)
  const branches = await storage.loadAllLogsFromSessionFile(file)
  for (const log of [full, lite, byId, byPath, ...branches]) expect(log?.darbInferenceBinding).toEqual(binding)
  storage.resetProjectForTesting()
  storage.restoreSessionMetadata(full)
  const helper = makeDarbSessionBinding(scope, { ...model, id: 'different-real-helper', catalog_revision: 'sha256:' + 'c'.repeat(64) })
  expect(() => storage.bindDarbSessionConnection(helper)).not.toThrow()
})

test('a fresh process restores the binding and rejects same model ID routed to another gateway', async () => {
  storage.bindDarbSessionConnection(binding)
  const storagePath = fileURLToPath(new URL('../sessionStorage.ts', import.meta.url))
  const managedPath = fileURLToPath(new URL('./darbModels.ts', import.meta.url))
  const child = Bun.spawnSync([process.execPath, '-e', `
    import { mock } from 'bun:test';
    const original = await import(${JSON.stringify(managedPath)});
    mock.module(${JSON.stringify(managedPath)}, () => ({ ...original, isDarbManagedInference: () => true }));
    const s = await import(${JSON.stringify(storagePath)});
    const log = await s.loadTranscriptFromFile(${JSON.stringify(file)});
    s.restoreSessionMetadata(log);
    s.bindDarbSessionConnection(${JSON.stringify(binding)});
    try { s.bindDarbSessionConnection(${JSON.stringify({ ...binding, connection_id: 'icn_' + 'd'.repeat(32) })}); process.exit(4); }
    catch (e) { if (!e.message.includes('No history was sent')) process.exit(5); }
  `], { cwd: process.cwd(), env: process.env, stdout: 'pipe', stderr: 'pipe' })
  expect(child.stderr.toString()).toBe('')
  expect(child.exitCode).toBe(0)
})

test('account, organization, connection and revision changes require explicit selection; refresh cannot rebind', async () => {
  storage.bindDarbSessionConnection(binding)
  const content = await readFile(file, 'utf8')
  for (const next of [
    makeDarbSessionBinding(JSON.stringify(['https://ai.darbmind.ru', 'account-B', 'org-A']), model),
    makeDarbSessionBinding(JSON.stringify(['https://ai.darbmind.ru', 'account-A', 'org-B']), model),
    { ...binding, connection_id: 'icn_' + 'd'.repeat(32) },
    { ...binding, connection_revision: 4 },
  ]) expect(() => storage.bindDarbSessionConnection(next)).toThrow('No history was sent')
  expect(await readFile(file, 'utf8')).toBe(content)
  const selected = { ...binding, connection_revision: 4 }
  storage.bindDarbSessionConnection(selected, true)
  expect((await storage.loadTranscriptFromFile(file)).darbInferenceBinding).toEqual(selected)
  expect(() => storage.bindDarbSessionConnection(binding)).toThrow('No history was sent')
})

test('custom/default transitions require explicit reselect and preserve durable history across restore',async()=>{
  storage.bindDarbSessionConnection(binding)
  const before=await storage.loadTranscriptFromFile(file),defaultBinding=makeDarbDefaultSessionBinding(scope)
  expect(parseDarbSessionBinding(defaultBinding)).toEqual(defaultBinding)
  expect(parseDarbSessionBinding({...defaultBinding,connection_id:model.connection_id})).toBeNull()
  expect(()=>storage.bindDarbSessionConnection(defaultBinding)).toThrow('No history was sent')
  storage.bindDarbSessionConnection(defaultBinding,true)
  const changed=await storage.loadTranscriptFromFile(file)
  expect(changed.messages).toEqual(before.messages)
  expect(changed.darbInferenceBinding).toEqual(defaultBinding)
  storage.resetProjectForTesting();storage.setSessionFileForTesting(file);storage.restoreSessionMetadata(changed)
  expect(()=>storage.bindDarbSessionConnection(defaultBinding)).not.toThrow()
  expect(()=>storage.bindDarbSessionConnection(binding)).toThrow('No history was sent')
  expect(()=>storage.bindDarbSessionConnection(makeDarbDefaultSessionBinding('another account/org'))).toThrow('No history was sent')
  storage.bindDarbSessionConnection(binding,true)
  expect((await storage.loadTranscriptFromFile(file)).darbInferenceBinding).toEqual(binding)
})

test('default SDK request sends no resumed custom history until explicit selection of default',async()=>{
  storage.restoreSessionMetadata({darbInferenceBinding:binding})
  const defaultBinding=makeDarbDefaultSessionBinding(scope)
  let sent=0
  const fetcher=(async()=>{sent++;return Response.json({id:'msg_default',type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}})}) as NonNullable<ClientOptions['fetch']>
  const client=new Anthropic({baseURL:'https://ai.darbmind.ru',apiKey:null,authToken:'fixture-default',maxRetries:0,
    fetch:guardDarbFetch(fetcher,'https://ai.darbmind.ru',undefined,()=>true,()=>storage.bindDarbSessionConnection(defaultBinding))})
  const request=async()=>await client.messages.create({model:'claude-sonnet-4-6',max_tokens:64,messages:[{role:'user',content:'Previously custom history'}]})
  await expect(request()).rejects.toThrow();expect(sent).toBe(0)
  storage.bindDarbSessionConnection(defaultBinding,true)
  await request();expect(sent).toBe(1)
})

test('legacy and malformed saved bindings fail closed, explicit model selection repairs them without changing history', async () => {
  for (const saved of [undefined, null, { ...binding, version: 99 }, { token: 'corrupt' }]) {
    await fixture(saved === undefined ? [message()] : [message(), entry(binding), entry(saved)])
    const log = await storage.loadTranscriptFromFile(file)
    storage.resetProjectForTesting()
    storage.setSessionFileForTesting(file)
    storage.restoreSessionMetadata(log)
    expect(() => storage.bindDarbSessionConnection(binding)).toThrow('No history was sent')
    storage.bindDarbSessionConnection(binding, true)
    const repaired = await storage.loadTranscriptFromFile(file)
    expect(repaired.darbInferenceBinding).toEqual(binding)
    expect(repaired.messages).toEqual(log.messages)
  }
})

test('fork preserves the source guard, clear permits a new connection, embedded runtimes stay unchanged', async () => {
  storage.restoreSessionMetadata({ darbInferenceBinding: binding })
  const other = { ...binding, connection_id: 'icn_' + 'e'.repeat(32) }
  expect(() => storage.bindDarbSessionConnection(other)).toThrow()
  storage.clearSessionMetadata()
  expect(() => storage.bindDarbSessionConnection(other)).not.toThrow()
  storage.resetProjectForTesting()
  storage.setSessionFileForTesting(file)
  managed = false
  const content = await readFile(file, 'utf8')
  storage.restoreSessionMetadata({})
  storage.reAppendSessionMetadata()
  expect(await readFile(file, 'utf8')).toBe(content)
})

test('no-session-persistence keeps the in-memory guard without creating metadata on disk', async () => {
  process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'
  const content = await readFile(file, 'utf8')
  storage.bindDarbSessionConnection(binding)
  storage.reAppendSessionMetadata()
  expect(await readFile(file, 'utf8')).toBe(content)
  expect(() => storage.bindDarbSessionConnection({ ...binding, connection_revision: 4 })).toThrow()
})

test('pre-compaction metadata survives the large transcript skip path', async () => {
  await fixture([entry(binding), message('x'.repeat(6 * 1024 * 1024)), {
    ...message(), uuid: '00000000-0000-4000-8000-000000000002', type: 'system', subtype: 'compact_boundary',
    message: undefined, content: 'Compacted', level: 'info', isMeta: false,
    compactMetadata: { trigger: 'manual', preTokens: 100 },
  }, { ...message(), uuid: '00000000-0000-4000-8000-000000000003', parentUuid: '00000000-0000-4000-8000-000000000002' }])
  expect((await storage.loadTranscriptFromFile(file)).darbInferenceBinding).toEqual(binding)
})

test('native SDK transport sends nothing on a resumed binding mismatch or storage failure', async () => {
  let sent = 0
  const fetcher = (async () => { sent++; return Response.json({}) }) as NonNullable<ClientOptions['fetch']>
  const client = new Anthropic({ baseURL: 'https://ai.darbmind.ru', apiKey: 'fixture', maxRetries: 0,
    fetch: guardDarbFetch(fetcher, 'https://ai.darbmind.ru', model, () => true, () => storage.bindDarbSessionConnection(binding)) })
  storage.restoreSessionMetadata({ darbInferenceBinding: { ...binding, connection_revision: 4 } })
  const request = async () => await client.messages.create({ model: model.id, max_tokens: 10, messages: [{ role: 'user', content: 'private history' }] })
  await expect(request()).rejects.toThrow()
  storage.clearSessionMetadata()
  storage.setSessionFileForTesting(dirs[0]!) // A directory cannot be a transcript file.
  await expect(request()).rejects.toThrow()
  expect(sent).toBe(0)
})

test('transport rechecks account/session fencing after asynchronous preflight', async () => {
  let current = true
  let sent = 0
  const guarded = guardDarbFetch((async () => { sent++; return Response.json({}) }) as NonNullable<ClientOptions['fetch']>,
    'https://ai.darbmind.ru', model, () => current, async () => { await Promise.resolve(); current = false })
  await expect(guarded('https://ai.darbmind.ru/v1/messages', { method: 'POST', body: JSON.stringify({ model: model.id }) })).rejects.toThrow()
  expect(sent).toBe(0)
})

test('per-model controls preserve reset versus off, are durable and do not cross models or scopes', async () => {
  storage.setDarbSessionThinking(binding, model.id, { type: 'effort_and_mode', mode: 'extended', effort: 'medium' })
  storage.setDarbSessionThinking(binding, 'Other/Exact[1m]', { type: 'mode', mode: 'off' })
  expect(readDarbSessionThinking(scope, model)).toEqual({ type: 'effort_and_mode', mode: 'extended', effort: 'medium' })
  expect(readDarbSessionThinking(scope, { ...model, id: 'Other/Exact[1m]' })).toEqual({ type: 'mode', mode: 'off' })
  const bytes = await readFile(file, 'utf8')
  storage.bindDarbSessionConnection(binding)
  storage.setDarbSessionThinking(binding, model.id, { type: 'effort_and_mode', mode: 'extended', effort: 'medium' })
  expect(await readFile(file, 'utf8')).toBe(bytes)
  const log = await storage.loadTranscriptFromFile(file)
  storage.resetProjectForTesting(); storage.setSessionFileForTesting(file); storage.restoreSessionMetadata(log)
  expect(readDarbSessionThinking(scope, model)?.mode).toBe('extended')
  storage.setDarbSessionThinking(binding, model.id, null)
  expect(readDarbSessionThinking(scope, model)).toBeNull()
  expect(readDarbSessionThinking(scope, { ...model, id: 'Other/Exact[1m]' })?.mode).toBe('off')
  for (const other of [{ ...model, connection_revision: 4 }, { ...model, connection_id: 'icn_' + 'c'.repeat(32) }]) expect(readDarbSessionThinking(scope, other)).toBeUndefined()
  expect(readDarbSessionThinking('another account', model)).toBeUndefined()
  expect(readDarbSessionThinking(scope, { ...model, id: 'other/exact[1m]' })).toBeUndefined()
  expect((await storage.loadTranscriptFromFile(file)).messages).toEqual(log.messages)
})

test('control persistence errors and malformed/revoked session bindings cannot change selected state', async () => {
  storage.bindDarbSessionConnection(binding)
  storage.setDarbSessionThinking(binding, model.id, null)
  storage.setSessionFileForTesting(dirs[0]!)
  expect(() => storage.setDarbSessionThinking(binding, model.id, { type:'mode', mode:'off' })).toThrow()
  expect(readDarbSessionThinking(scope, model)).toBeNull()
  expect(() => storage.setDarbSessionThinking({...binding,connection_revision:4}, model.id, null)).toThrow('No history was sent')
  storage.restoreSessionMetadata({darbInferenceBinding:null})
  expect(() => storage.setDarbSessionThinking(binding, model.id, null)).toThrow('No history was sent')
  for (const controls_by_model of [[{model:model.id,thinking:{type:'mode',mode:'enabled'}}], [{model:model.id,thinking:null},{model:model.id,thinking:null}], [{model:'x\n',thinking:null}]]) expect(parseDarbSessionBinding({...binding,controls_by_model})).toBeNull()
})
