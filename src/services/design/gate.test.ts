import { beforeEach, describe, expect, test } from 'bun:test'
import {
  designGateFailureWithDependencies,
  type DesignGateDependencies,
} from './gate.js'

let allowDesignSync = true
let featureEnabled = true
let provider = 'firstParty'
let firstPartyBase = true
let hostManaged = false
let essentialOnly = false

function failure() {
  return designGateFailureWithDependencies({
    allowDesignSync: () => allowDesignSync,
    featureEnabled: () => featureEnabled,
    apiProvider: () => provider,
    firstPartyAnthropicBaseUrl: () => firstPartyBase,
    hostManagedExternalInference: () => hostManaged,
    essentialTrafficOnly: () => essentialOnly,
  } satisfies DesignGateDependencies)
}

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
    expect(failure()).toBe('disabled')
    allowDesignSync = true
    featureEnabled = false
    expect(failure()).toBe('disabled')
  })

  test('fails closed for ordinary third-party providers and custom bases', () => {
    provider = 'openai'
    expect(failure()).toBe('wrong_provider')
    provider = 'firstParty'
    firstPartyBase = false
    expect(failure()).toBe('wrong_provider')
  })

  test('allows only the explicit host-managed split control/model plane', () => {
    provider = 'openai'
    firstPartyBase = false
    hostManaged = true
    expect(failure()).toBe(null)
  })

  test('blocks nonessential traffic before any Design request', () => {
    essentialOnly = true
    expect(failure()).toBe('essential_traffic_only')
  })
})
