import { beforeEach, describe, expect, mock, test } from 'bun:test'

let allowDesignSync = true
let featureEnabled = true
let provider = 'firstParty'
let firstPartyBase = true
let hostManaged = false
let essentialOnly = false

mock.module('../../utils/settings/settings.js', () => ({
  getSettingsForSource: () =>
    allowDesignSync ? { allow_design_sync: true } : {},
}))
mock.module('../analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => featureEnabled,
}))
mock.module('../../utils/model/providers.js', () => ({
  getAPIProvider: () => provider,
  isFirstPartyAnthropicBaseUrl: () => firstPartyBase,
}))
mock.module('../../utils/privacyLevel.js', () => ({
  isEssentialTrafficOnly: () => essentialOnly,
}))
mock.module('../../constants/oauth.js', () => ({
  DESIGN_OAUTH_SCOPES: ['user:design:read', 'user:design:write'],
  getOauthConfig: () => ({ BASE_API_URL: 'https://ai.darbmind.ru' }),
  isHostManagedExternalInference: () => hostManaged,
}))

const { designGateFailure } = await import('./gate.js')

beforeEach(() => {
  allowDesignSync = true
  featureEnabled = true
  provider = 'firstParty'
  firstPartyBase = true
  hostManaged = false
  essentialOnly = false
})

describe('Claude Design feature gate', () => {
  test('requires both managed policy and GrowthBook activation', () => {
    allowDesignSync = false
    expect(designGateFailure()).toBe('disabled')
    allowDesignSync = true
    featureEnabled = false
    expect(designGateFailure()).toBe('disabled')
  })

  test('fails closed for ordinary third-party providers and custom bases', () => {
    provider = 'openai'
    expect(designGateFailure()).toBe('wrong_provider')
    provider = 'firstParty'
    firstPartyBase = false
    expect(designGateFailure()).toBe('wrong_provider')
  })

  test('allows only the explicit host-managed split control/model plane', () => {
    provider = 'openai'
    firstPartyBase = false
    hostManaged = true
    expect(designGateFailure()).toBe(null)
  })

  test('blocks nonessential traffic before any Design request', () => {
    essentialOnly = true
    expect(designGateFailure()).toBe('essential_traffic_only')
  })
})
