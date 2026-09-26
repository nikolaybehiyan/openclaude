import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'

const growthbook = await import('../services/analytics/growthbook.js')
let config: Record<string, unknown> = {}
mock.module('../services/analytics/growthbook.js', () => ({
  ...growthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: (key: string, fallback: unknown) =>
    key === 'tengu_auto_mode_config' ? config : fallback,
}))
const providers = await import('./model/providers.js')
let provider = 'firstParty'
mock.module('./model/providers.js', () => ({ ...providers, getAPIProvider: () => provider }))
const { modelSupportsAutoMode } = await import('./betas.js')
const env = { ...process.env }
afterAll(() => { process.env = env; mock.restore() })
beforeEach(() => {
  config = {}
  provider = 'firstParty'
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_GB_BASE_URL
})

if (feature('TRANSCRIPT_CLASSIFIER')) {
  test('host all-model policy admits current and future catalog IDs on proxied providers', () => {
    config = { allowAllModels: true, allowModels: ['claude-sonnet-5'] }
    process.env.CLAUDE_CODE_GB_BASE_URL = 'https://ai.darbmind.ru'
    for (const p of ['firstParty', 'bedrock', 'vertex', 'foundry']) {
      provider = p
      for (const model of ['deepseek-v4-pro', 'glm-5.3', 'qwen3-max', 'future/vendor-model', 'claude-sonnet-5']) {
        expect(modelSupportsAutoMode(model)).toBe(true)
      }
    }
  })

  test('missing, false and malformed all-model policy retain model gating', () => {
    process.env.CLAUDE_CODE_GB_BASE_URL = 'https://ai.darbmind.ru'
    for (const allowAllModels of [undefined, false, 'true', 1]) {
      config = { allowAllModels, allowModels: ['DEEPSEEK-V4-PRO'] }
      expect(modelSupportsAutoMode('deepseek-v4-pro')).toBe(true)
      expect(modelSupportsAutoMode('future/vendor-model')).toBe(false)
    }
  })

  test('all-model policy does not authorize a direct third-party provider without host control', () => {
    config = { allowAllModels: true }
    provider = 'bedrock'
    expect(modelSupportsAutoMode('deepseek-v4-pro')).toBe(false)
    process.env.CLAUDE_CODE_GB_BASE_URL = '   '
    expect(modelSupportsAutoMode('deepseek-v4-pro')).toBe(false)
  })
} else {
  test('all-model policy cannot enable a build without the permission classifier', () => {
    config = { allowAllModels: true }
    process.env.CLAUDE_CODE_GB_BASE_URL = 'https://ai.darbmind.ru'
    expect(modelSupportsAutoMode('deepseek-v4-pro')).toBe(false)
    expect(modelSupportsAutoMode('claude-sonnet-4-6')).toBe(false)
  })
}
