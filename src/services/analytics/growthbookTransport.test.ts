import { describe, expect, test } from 'bun:test'
import { resolveGrowthBookTransport } from './growthbookTransport.js'

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
})

