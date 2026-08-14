import { describe, expect, test } from 'bun:test'
import {
  hasHostManagedFirstPartyEventLogging,
  resolveFirstPartyEventLoggingBaseUrl,
} from './firstPartyEventLoggingTransport.js'

describe('first-party event logging transport', () => {
  test('keeps OpenClaude telemetry disabled without a host-managed endpoint', () => {
    expect(hasHostManagedFirstPartyEventLogging({})).toBe(false)
    expect(resolveFirstPartyEventLoggingBaseUrl(undefined, {})).toBe(
      'https://api.anthropic.com',
    )
  })

  test('uses the Darbmind control-plane origin for a host-managed build', () => {
    const environment = {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_GB_BASE_URL: 'https://ai.darbmind.ru',
    }
    expect(hasHostManagedFirstPartyEventLogging(environment)).toBe(true)
    expect(
      resolveFirstPartyEventLoggingBaseUrl(
        'https://api.anthropic.com',
        environment,
      ),
    ).toBe('https://ai.darbmind.ru')
  })

  test('does not infer telemetry ownership from an unmanaged feature endpoint', () => {
    const environment = {
      CLAUDE_CODE_GB_BASE_URL: 'https://features.example.test',
    }
    expect(hasHostManagedFirstPartyEventLogging(environment)).toBe(false)
    expect(resolveFirstPartyEventLoggingBaseUrl(undefined, environment)).toBe(
      'https://api.anthropic.com',
    )
  })

  test('rejects a host endpoint containing a path or credentials', () => {
    expect(() =>
      resolveFirstPartyEventLoggingBaseUrl(undefined, {
        CLAUDE_CODE_1P_EVENT_LOGGING_BASE_URL:
          'https://user:secret@ai.darbmind.ru/events',
      }),
    ).toThrow('CLAUDE_CODE_1P_EVENT_LOGGING_BASE_URL')
  })
})
