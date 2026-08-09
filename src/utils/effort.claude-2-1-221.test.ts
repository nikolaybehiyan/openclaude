import { afterEach, expect, mock, test } from 'bun:test'
import * as actualAuth from './auth.js'
import * as actualProviderConfig from '../services/api/providerConfig.js'
import * as actualThinking from './thinking.js'
import * as actualGrowthbook from 'src/services/analytics/growthbook.js'
import * as actualProviders from './model/providers.js'
import * as actualModelSupportOverrides from './model/modelSupportOverrides.js'

afterEach(() => {
  mock.restore()
})

async function importEffortWithCapabilities(
  capabilities: ReadonlySet<string>,
) {
  mock.module('./model/providers.js', () => ({
    ...actualProviders,
    getAPIProvider: () => 'bedrock',
  }))
  mock.module('./model/modelSupportOverrides.js', () => ({
    ...actualModelSupportOverrides,
    get3PModelCapabilityOverride: (_model: string, capability: string) =>
      capabilities.has(capability),
  }))
  mock.module('../services/api/providerConfig.js', () => ({
    ...actualProviderConfig,
    supportsCodexReasoningEffort: () => false,
  }))
  mock.module('./auth.js', () => ({
    ...actualAuth,
    isProSubscriber: () => false,
    isMaxSubscriber: () => false,
    isTeamSubscriber: () => false,
  }))
  mock.module('./thinking.js', () => ({
    ...actualThinking,
    isUltrathinkEnabled: () => false,
  }))
  mock.module('src/services/analytics/growthbook.js', () => ({
    ...actualGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) =>
      fallback,
  }))

  return import(`./effort.js?claude221=${Date.now()}-${Math.random()}`)
}

test('Claude 2.1.221 accepts xhigh as a named effort level', async () => {
  const { EFFORT_LEVELS, parseEffortValue, toPersistableEffort } =
    await importEffortWithCapabilities(
      new Set(['effort', 'xhigh_effort', 'max_effort']),
    )

  expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(parseEffortValue('XHIGH')).toBe('xhigh')
  expect(toPersistableEffort('xhigh')).toBe('xhigh')
  expect(toPersistableEffort('max')).toBeUndefined()
})

test('Desktop pinned model advertises xhigh and max from capability projection', async () => {
  const { getAvailableEffortLevels } = await importEffortWithCapabilities(
    new Set(['effort', 'xhigh_effort', 'max_effort']),
  )

  expect(getAvailableEffortLevels('claude-opus-4-8')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
})

test('unsupported xhigh and max fall back to the highest supported tier below them', async () => {
  const { resolveAppliedEffort } = await importEffortWithCapabilities(
    new Set(['effort']),
  )

  expect(resolveAppliedEffort('claude-sonnet-custom', 'xhigh')).toBe('high')
  expect(resolveAppliedEffort('claude-sonnet-custom', 'max')).toBe('high')
})

test('max falls back to xhigh when max is absent but xhigh is supported', async () => {
  const { resolveAppliedEffort } = await importEffortWithCapabilities(
    new Set(['effort', 'xhigh_effort']),
  )

  expect(resolveAppliedEffort('claude-opus-custom', 'max')).toBe('xhigh')
})

test('Claude 2.1.221 defaults Opus 4.7 to xhigh', async () => {
  const { getDefaultEffortForModel } = await importEffortWithCapabilities(
    new Set(['effort', 'xhigh_effort', 'max_effort']),
  )

  expect(getDefaultEffortForModel('claude-opus-4-7')).toBe('xhigh')
})
