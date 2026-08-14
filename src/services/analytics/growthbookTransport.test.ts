import { describe, expect, test } from 'bun:test'
import {
  isGrowthBookControlPlaneEnabled,
  resolveGrowthBookTransport,
} from './growthbookTransport.js'

describe('GrowthBook transport', () => {
  test('keeps the official Anthropic endpoint and auth contract by default', () => {
    expect(resolveGrowthBookTransport({})).toEqual({
      apiHost: 'https://api.anthropic.com/',
      requiresAnthropicAuth: true,
    })
  })

  test('uses the host-managed remote-eval endpoint without provider auth', () => {
    expect(
      resolveGrowthBookTransport({
        CLAUDE_CODE_GB_BASE_URL: 'https://ai.darbmind.ru',
      }),
    ).toEqual({
      apiHost: 'https://ai.darbmind.ru/',
      requiresAnthropicAuth: false,
    })
  })

  test('rejects a malformed host-managed endpoint instead of falling back to Anthropic', () => {
    expect(() =>
      resolveGrowthBookTransport({
        CLAUDE_CODE_GB_BASE_URL: 'https://user:secret@ai.darbmind.ru/eval?leak=1',
      }),
    ).toThrow('CLAUDE_CODE_GB_BASE_URL')
  })

  test('keeps host-managed feature control enabled when product telemetry is disabled', () => {
    expect(
      isGrowthBookControlPlaneEnabled(false, {
        CLAUDE_CODE_GB_BASE_URL: 'https://ai.darbmind.ru',
      }),
    ).toBe(true)
  })

  test('stays disabled without telemetry or a host-managed control plane', () => {
    expect(isGrowthBookControlPlaneEnabled(false, {})).toBe(false)
    expect(
      isGrowthBookControlPlaneEnabled(false, {
        CLAUDE_CODE_GB_BASE_URL: '   ',
      }),
    ).toBe(false)
  })
})
