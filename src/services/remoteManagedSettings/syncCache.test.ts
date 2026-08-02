import { afterEach, describe, expect, test } from 'bun:test'
import {
  isRemoteManagedSettingsEligible,
  resetSyncCache,
} from './syncCache.js'

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
] as const

const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetSyncCache()
})

describe('remote managed settings host ownership', () => {
  test('allows an externally authenticated trusted desktop control plane', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://ai.claudia.ru'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-from-desktop'
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    resetSyncCache()

    expect(isRemoteManagedSettingsEligible()).toBe(true)
  })

  test('does not send settings credentials to an ordinary custom gateway', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://model-gateway.example.test'
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-from-user-config'
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    resetSyncCache()

    expect(isRemoteManagedSettingsEligible()).toBe(false)
  })
})
