import { afterEach, describe, expect, test } from 'bun:test'
import { getOauthConfig } from './oauth.js'

const ORIGINAL_ENV = {
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
  CLAUDE_CODE_CUSTOM_OAUTH_URL: process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL,
}

function restoreEnv(
  key: keyof typeof ORIGINAL_ENV,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(key as keyof typeof ORIGINAL_ENV, value)
  }
})

describe('getOauthConfig host-managed API routing', () => {
  test('keeps third-party inference gateways away from Code account APIs', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://model-gateway.example.test'
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL

    expect(getOauthConfig().BASE_API_URL).toBe('https://api.anthropic.com')
  })

  test('routes all API-hosted Code contracts through the trusted host endpoint', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://ai.claudia.ru/'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL

    const config = getOauthConfig()
    expect(config.BASE_API_URL).toBe('https://ai.claudia.ru')
    expect(config.API_KEY_URL).toBe(
      'https://ai.claudia.ru/api/oauth/claude_cli/create_api_key',
    )
    expect(config.ROLES_URL).toBe(
      'https://ai.claudia.ru/api/oauth/claude_cli/roles',
    )
    expect(config.CLAUDE_AI_AUTHORIZE_URL).toBe(
      'https://claude.com/cai/oauth/authorize',
    )
  })

  test('rejects an invalid trusted host endpoint', () => {
    process.env.ANTHROPIC_BASE_URL = 'file:///tmp/claude.sock'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL

    expect(() => getOauthConfig()).toThrow(
      'Host-managed ANTHROPIC_BASE_URL must be an absolute HTTP(S) URL',
    )
  })
})
