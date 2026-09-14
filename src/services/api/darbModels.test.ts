import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { DarbCatalogSession } from '../../utils/model/darbCatalog.js'

let enabled = true
let scope: string | undefined = 'account-A/org-A'
let token: string | undefined = 'fixture-only-oauth'
const session = new DarbCatalogSession()
const get = mock(async (_url: string, _options: unknown): Promise<{ data: unknown }> => ({ data: payload() }))
const binding = { connection_id: 'icn_' + 'a'.repeat(32), connection_revision: 4, catalog_revision: 'sha256:' + 'b'.repeat(64) }
function payload() {
  return { data: [{ ...binding, id: 'Real/Model', display_name: 'Real Model' }],
    saved_selection: { ...binding, model: 'Real/Model' }, has_more: false }
}
mock.module('axios', () => ({ default: { get, isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError } }))
mock.module('../../utils/auth.js', () => ({ getClaudeAIOAuthTokens: () => token ? { accessToken: token } : null }))
mock.module('../../utils/http.js', () => ({ withOAuth401Retry: (fn: () => Promise<unknown>) => fn() }))
mock.module('../../utils/userAgent.js', () => ({ getClaudeCodeUserAgent: () => 'fixture-cli' }))
mock.module('../../utils/model/darbModels.js', () => ({
  darbCatalogSession: session, darbModelScope: () => scope, isDarbManagedInference: () => enabled,
}))
const { refreshDarbModels, darbCatalogErrorMessage } = await import('./darbModels.js')

beforeEach(() => {
  enabled = true; scope = 'account-A/org-A'; token = 'fixture-only-oauth'
  get.mockReset(); get.mockImplementation(async () => ({ data: payload() }))
})
afterAll(() => mock.restore())

test('catalog uses authenticated Darb only, no redirect, bounded time and body size', async () => {
  await refreshDarbModels()
  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0]![0]).toBe('https://ai.darbmind.ru/v1/models?limit=1000')
  expect(get.mock.calls[0]![1]).toEqual({ headers: { Authorization: 'Bearer fixture-only-oauth', 'User-Agent': 'fixture-cli' },
    timeout: 10000, maxRedirects: 0, maxContentLength: 2097152 })
  expect(session.current(scope)?.defaultModel).toBe('Real/Model')
})

test('skips non-Darb clients, refuses missing account/token before network', async () => {
  enabled = false
  await refreshDarbModels()
  enabled = true; scope = undefined
  await expect(refreshDarbModels()).rejects.toThrow('Sign in')
  scope = 'account-A/org-A'; token = undefined
  await expect(refreshDarbModels()).rejects.toThrow('sign in')
  expect(get).toHaveBeenCalledTimes(0)
})

test('a late response after account switch is not cached', async () => {
  get.mockImplementation(async () => { scope = 'account-B/org-A'; return { data: payload() } })
  await expect(refreshDarbModels()).rejects.toThrow('account changed')
  expect(session.current(scope)).toBeUndefined()
  expect(session.current('account-A/org-A')).toBeUndefined()
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
  await expect(refreshDarbModels()).rejects.toThrow('Connect AI')
  expect(session.current(scope)).toBeUndefined()
})
