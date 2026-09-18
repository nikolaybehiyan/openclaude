import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { DarbCatalogSession } from '../../utils/model/darbCatalog.js'

let enabled = true
const accountScope = JSON.stringify(['https://ai.darbmind.ru', 'account-A', 'org-A'])
let scope: string | undefined = accountScope
let token: string | undefined = 'fixture-only-oauth'
const session = new DarbCatalogSession()
const get = mock(async (_url: string, _options: unknown): Promise<{ data: unknown }> => ({ data: payload() }))
const binding = { connection_id: 'icn_' + 'a'.repeat(32), connection_revision: 4, catalog_revision: 'sha256:' + 'b'.repeat(64) }
function payload() {
  return { configuration_mode:'custom', configuration_revision:3, status:'ready', account_uuid:'account-A', organization_uuid:'org-A',
    model_selector_config:[{id:'cli',inference_connection:{mode:'custom',status:'ready',configuration_revision:3},models:[{ ...binding, id:'Real/Model',name:'Real Model' }]}],
    model_selector_state:[{id:'cli',...binding,model:'Real/Model',thinking:null,thinking_by_model:[]}] }
}
const patch = mock(async (_url: string, _body: unknown, _options: unknown) => ({data:{...payload().model_selector_state[0],configuration_mode:'custom',configuration_revision:3,selection_revision:1,account_uuid:'account-A',organization_uuid:'org-A'}}))
mock.module('axios', () => ({ default: { get, patch, isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError } }))
mock.module('../../utils/auth.js', () => ({ getClaudeAIOAuthTokens: () => token ? { accessToken: token } : null }))
mock.module('../../utils/http.js', () => ({ withOAuth401Retry: (fn: () => Promise<unknown>) => fn() }))
mock.module('../../utils/userAgent.js', () => ({ getClaudeCodeUserAgent: () => 'fixture-cli' }))
mock.module('../../utils/model/darbModels.js', () => ({
  darbCatalogSession: session, darbModelScope: () => scope, isDarbManagedInference: () => enabled,
  currentDarbCustomCatalog: () => session.current(scope),
  requireDarbModelCandidate: (id: string) => { const catalog=session.current(scope); const row=catalog?.mode==='custom'?catalog.models.find(row=>row.id===id):undefined; if(!row)throw new Error('Connect AI'); return row },
}))
const { refreshDarbModels, darbCatalogErrorMessage, saveDarbModelSelection } = await import('./darbModels.js')

beforeEach(() => {
  enabled = true; scope = accountScope; token = 'fixture-only-oauth'
  get.mockReset(); get.mockImplementation(async () => ({ data: payload() }))
  patch.mockClear()
})
afterAll(() => mock.restore())

test('catalog uses authenticated Darb only, no redirect, bounded time and body size', async () => {
  await refreshDarbModels()
  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0]![0]).toBe('https://ai.darbmind.ru/api/organizations/org-A/model_selector/cli')
  expect(get.mock.calls[0]![1]).toEqual({ headers: { Authorization: 'Bearer fixture-only-oauth', 'User-Agent': 'fixture-cli' },
    timeout: 10000, maxRedirects: 0, maxContentLength: 2097152 })
  expect(session.current(scope)?.defaultModel).toBe('Real/Model')
})

test('the actual public default projection refreshes successfully and cannot survive a later failed refresh', async () => {
  get.mockImplementation(async(url)=>({data:url.includes('/model_selector/')?{configuration_mode:'default',configuration_revision:3,account_uuid:'account-A',organization_uuid:'org-A'}:{configuration_mode:'default',data:[{id:'claude-sonnet-4-6',type:'model',display_name:'Sonnet 4.6'}],has_more:false,first_id:'claude-sonnet-4-6',last_id:'claude-sonnet-4-6'}}))
  await refreshDarbModels()
  expect(session.current(scope)?.mode).toBe('default')
  expect(session.current(scope)?.defaultModel).toBeUndefined()
  get.mockImplementation(async()=>{throw {isAxiosError:true,response:{status:503}}})
  await expect(refreshDarbModels()).rejects.toThrow('could not be loaded')
  expect(session.current(scope)).toBeUndefined()
})

test('skips non-Darb clients, refuses missing account/token before network', async () => {
  enabled = false
  await refreshDarbModels()
  enabled = true; scope = undefined
  await expect(refreshDarbModels()).rejects.toThrow('Sign in')
  scope = accountScope; token = undefined
  await expect(refreshDarbModels()).rejects.toThrow('sign in')
  expect(get).toHaveBeenCalledTimes(0)
})

test('a late response after account switch is not cached', async () => {
  get.mockImplementation(async () => { scope = JSON.stringify(['https://ai.darbmind.ru','account-B','org-A']); return { data: payload() } })
  await expect(refreshDarbModels()).rejects.toThrow('account changed')
  expect(session.current(scope)).toBeUndefined()
  expect(session.current(accountScope)).toBeUndefined()
})

test('authorization, stale selection and transport failures are distinct and never retain the old catalog', async () => {
  for (const [status, expected] of [[401, 'sign-in expired'], [403, 'organization'], [409, 'selection changed'], [503, 'could not be loaded']] as const) {
    get.mockImplementation(async () => ({ data: payload() }))
    await refreshDarbModels()
    get.mockImplementation(async () => { throw { isAxiosError: true, response: { status, data: 'fixture-secret-do-not-print' } } })
    try { await refreshDarbModels(); throw new Error('expected denial') } catch (error) {
      expect(darbCatalogErrorMessage(error)).toContain(expected)
      expect(darbCatalogErrorMessage(error)).not.toContain('fixture-secret')
    }
    expect(session.current(scope)).toBeUndefined()
  }
})

test('legacy catalog is actionable Connect AI, not an outage or fabricated default', async () => {
  get.mockImplementation(async () => ({ data: { data: [{ id: 'sonnet' }], has_more: false } }))
  await expect(refreshDarbModels()).rejects.toThrow()
  expect(session.current(scope)).toBeUndefined()
})

test('explicit selection uses scoped authenticated PATCH fences and accepts only confirmed owner state', async () => {
  await refreshDarbModels()
  await saveDarbModelSelection('Real/Model',null)
  expect(patch).toHaveBeenCalledTimes(1)
  expect(patch.mock.calls[0]![0]).toBe('https://ai.darbmind.ru/api/organizations/org-A/model_selector_state/cli')
  expect(patch.mock.calls[0]![1]).toEqual({model:'Real/Model',thinking:null,configuration_revision:3,account_uuid:'account-A',organization_uuid:'org-A',...binding})
  expect(session.current(scope)?.defaultModel).toBe('Real/Model')
  expect((session.current(scope) as any)?.models[0].selected_thinking).toBeNull()
})

test('changed owner catalog remains selectable but only an explicit acknowledged save confirms it', async () => {
  const changed=payload()
  changed.status='selection_required'
  changed.model_selector_config[0]!.inference_connection.status='selection_required'
  get.mockImplementation(async()=>({data:changed}))
  await refreshDarbModels()
  expect((session.current(scope) as any)?.selectionRequired).toBe(true)
  expect(patch).toHaveBeenCalledTimes(0)
  await saveDarbModelSelection('Real/Model',null)
  expect(patch).toHaveBeenCalledTimes(1)
  expect((session.current(scope) as any)?.selectionRequired).toBeUndefined()
  expect(session.current(scope)?.defaultModel).toBe('Real/Model')
})

test('selection-required catalogs retain account, revision and matching status validation', async () => {
  for (const mismatch of ['account','revision','status']) {
    const changed=payload()
    changed.status='selection_required'
    changed.model_selector_config[0]!.inference_connection.status='selection_required'
    if(mismatch==='account')changed.account_uuid='account-B'
    if(mismatch==='revision')changed.configuration_revision++
    if(mismatch==='status')changed.model_selector_config[0]!.inference_connection.status='ready'
    get.mockImplementation(async()=>({data:changed}))
    await expect(refreshDarbModels()).rejects.toThrow()
    expect(session.current(scope)).toBeUndefined()
  }
  expect(patch).toHaveBeenCalledTimes(0)
})

test('failed or cross-account writes do not ACK, fall back or retain authorization', async () => {
  for(const failure of ['network','account']) {
    scope=accountScope
    await refreshDarbModels()
    patch.mockImplementationOnce(async()=>{
      if(failure==='network')throw new Error('fixture-private-response')
      return {data:{...payload().model_selector_state[0],configuration_mode:'custom',configuration_revision:3,selection_revision:1,account_uuid:'account-B',organization_uuid:'org-A'}}
    })
    await expect(saveDarbModelSelection('Real/Model',null)).rejects.toThrow('could not be confirmed')
    expect(session.current(scope)).toBeUndefined()
  }
})
