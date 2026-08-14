import { describe, expect, test } from 'bun:test'
import { resolveGrowthBookFeatureValue } from './growthbookFeatureValue.js'

describe('resolveGrowthBookFeatureValue', () => {
  test('uses the complete disk snapshot when remote init has no payload', () => {
    const value = resolveGrowthBookFeatureValue({
      feature: 'tengu_auto_mode_config',
      remoteValues: new Map(),
      diskValues: {
        tengu_auto_mode_config: { enabled: 'enabled' },
      },
      sdkValue: () => ({}),
    })

    expect(value).toEqual({ enabled: 'enabled' })
  })

  test('prefers a processed remote value over disk', () => {
    const value = resolveGrowthBookFeatureValue({
      feature: 'tengu_auto_mode_config',
      remoteValues: new Map([
        ['tengu_auto_mode_config', { enabled: 'opt-in' }],
      ]),
      diskValues: {
        tengu_auto_mode_config: { enabled: 'enabled' },
      },
      sdkValue: () => ({ enabled: 'disabled' }),
    })

    expect(value).toEqual({ enabled: 'opt-in' })
  })

  test('does not resurrect a removed feature from disk after remote load', () => {
    const value = resolveGrowthBookFeatureValue({
      feature: 'removed_feature',
      remoteValues: new Map([['another_feature', true]]),
      diskValues: { removed_feature: 'stale' },
      sdkValue: () => 'default',
    })

    expect(value).toBe('default')
  })

  test('falls back to the SDK when neither complete cache owns the feature', () => {
    const value = resolveGrowthBookFeatureValue({
      feature: 'unknown_feature',
      remoteValues: new Map(),
      diskValues: {},
      sdkValue: () => 'default',
    })

    expect(value).toBe('default')
  })
})
