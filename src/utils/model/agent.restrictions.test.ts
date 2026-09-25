import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { setMainLoopModelOverride, setModelStrings } from '../../bootstrap/state.js'
import { LEGACY_PROVIDER_MODEL_CONFIGS } from './configs.js'
import type { LegacyAPIProvider } from './providers.js'
import type { SettingsJson } from '../settings/types.js'

const originalEnv = { ...process.env }
const settingsModule = await import('../settings/settings.js')
const providers = await import('./providers.js')
let settings: Partial<SettingsJson> = {}
let provider: LegacyAPIProvider = 'firstParty'
mock.module('../settings/settings.js', () => ({
  ...settingsModule, getSettings_DEPRECATED: () => settings, getInitialSettings: () => settings,
}))
mock.module('./providers.js', () => ({
  ...providers, getAPIProvider: () => provider, isFirstPartyAnthropicBaseUrl: () => true,
}))
const { getAgentModel } = await import('./agent.js')
const { getNewestAllowedModelInFamily } = await import('./allowedFamilyFallback.js')
const sonnet = 'claude-sonnet-4-6', haiku = 'claude-haiku-4-5-20251001'

function useProvider(value: LegacyAPIProvider) {
  provider = value
  setModelStrings(Object.fromEntries(Object.entries(LEGACY_PROVIDER_MODEL_CONFIGS).map(([key, row]) => [key, row[value]])) as never)
}
beforeEach(() => {
  settings = {}
  useProvider('firstParty')
  setMainLoopModelOverride(undefined)
  for (const key of ['CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'DARB_FROZEN_MODEL_CONTEXT_JSON']) delete process.env[key]
})
afterAll(() => {
  settings = {}
  provider = 'firstParty'
  mock.restore()
  setModelStrings(null)
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})

test('environment override wins; environment inherit defers to the tool and frontmatter', () => {
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = haiku
  expect(getAgentModel(sonnet, sonnet, 'claude-opus-4-6')).toBe(haiku)
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherit'
  expect(getAgentModel(sonnet, sonnet, haiku)).toBe(haiku)
  expect(getAgentModel(haiku, sonnet)).toBe(haiku)
  expect(getAgentModel(haiku, sonnet, 'inherit')).toBe(sonnet)
})

test('allowed IDs and same-family parent versions remain unchanged without notification', () => {
  settings.availableModels = ['opus', 'sonnet', 'Vendor/Exact-ID']
  const changed = mock(() => {})
  expect(getAgentModel('opus', 'claude-opus-4-6', undefined, 'default', changed)).toBe('claude-opus-4-6')
  expect(getAgentModel('Vendor/Exact-ID', sonnet, undefined, 'default', changed)).toBe('Vendor/Exact-ID')
  expect(changed).not.toHaveBeenCalled()
})

test('restricted family selects newest permitted registered model with true notification', () => {
  // Exact IDs make the newest choice independent of version-prefix matching.
  settings.availableModels = ['claude-sonnet-4-20250514', 'claude-sonnet-4-5-20250929', haiku]
  const changed = mock(() => {})
  expect(getAgentModel('sonnet', haiku, undefined, 'default', changed)).toBe('claude-sonnet-4-5-20250929')
  expect(changed.mock.calls).toEqual([['sonnet', 'claude-sonnet-4-5-20250929']])
})

test('family fallback does not resolve through an environment alias override', () => {
  settings.availableModels = ['sonnet-4-5', haiku]
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'Vendor/Disallowed'
  expect(getAgentModel('sonnet', haiku)).toBe('claude-sonnet-4-5-20250929')
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'sonnet'
  expect(getAgentModel('opus', haiku)).toBe('claude-sonnet-4-5-20250929')
})

test('concrete denied model uses parent, without guessing a family substitute', () => {
  settings.availableModels = ['sonnet-4-5', haiku]
  const changed = mock(() => {})
  expect(getAgentModel(sonnet, haiku, undefined, 'default', changed)).toBe(haiku)
  expect(changed.mock.calls).toEqual([[sonnet, haiku]])
  expect(getNewestAllowedModelInFamily(sonnet)).toBeNull()
  expect(getNewestAllowedModelInFamily('best')).toBeNull()
})

test('no permitted family or parent fails closed', () => {
  settings.availableModels = []
  const changed = mock(() => {})
  expect(() => getAgentModel('opus', sonnet, undefined, 'default', changed)).toThrow('no permitted fallback')
  expect(() => getAgentModel('inherit', sonnet)).toThrow('restricted')
  expect(changed).not.toHaveBeenCalled()
})

test('deprecated and unknown catalog candidates are not synthesized from an allowlist', () => {
  settings.availableModels = ['claude-3-7-sonnet-20250219', 'claude-sonnet-99', haiku]
  expect(getNewestAllowedModelInFamily('sonnet')).toBeNull()
  expect(getAgentModel('sonnet', haiku)).toBe(haiku)
})

test('explicit 1M alias keeps a supported allowed context variant', () => {
  settings.availableModels = ['sonnet-4-5', haiku]
  expect(getAgentModel('sonnet[1m]', haiku)).toBe('claude-sonnet-4-5-20250929[1m]')
  process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
  expect(getNewestAllowedModelInFamily('sonnet[1m]')).toBe('claude-sonnet-4-5-20250929')
})

test('Bedrock preserves parent region for aliases and explicit cross-region IDs', () => {
  useProvider('bedrock')
  settings.availableModels = ['sonnet', 'haiku']
  const parent = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0'
  expect(getAgentModel('haiku', parent)).toBe('eu.anthropic.claude-haiku-4-5-20251001-v1:0')
  const explicit = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
  expect(getAgentModel(explicit, parent)).toBe(explicit)
  settings.availableModels = ['sonnet']
  const changed = mock(() => {})
  expect(getAgentModel('haiku', parent, undefined, 'default', changed)).toBe(parent)
  expect(changed.mock.calls).toEqual([['haiku', parent]])
  expect(getNewestAllowedModelInFamily('sonnet')).toBeNull()
})

test('non-Claude providers retain their provider-aware inheritance', () => {
  useProvider('openai')
  settings.availableModels = ['Vendor/Exact-ID']
  expect(getAgentModel('haiku', 'Vendor/Exact-ID')).toBe('Vendor/Exact-ID')
  expect(getNewestAllowedModelInFamily('sonnet')).toBeNull()
})
