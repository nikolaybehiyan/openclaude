import { afterEach, describe, expect, test } from 'bun:test'
import {
  getOauthConfig,
  isHostManagedExternalInference,
} from './oauth.js'

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

describe('host-managed Code control and inference routing', () => {
  test('keeps third-party inference gateways away from Code account APIs', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://model-gateway.example.test'
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL

    expect(getOauthConfig().BASE_API_URL).toBe('https://api.anthropic.com')
  })

  test('keeps Code account APIs on the trusted control plane while inference is external', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.claudia.ru'

    const config = getOauthConfig()
    expect(config.BASE_API_URL).toBe('https://ai.claudia.ru')
    expect(config.API_KEY_URL).toBe(
      'https://ai.claudia.ru/api/oauth/claude_cli/create_api_key',
    )
    expect(config.ROLES_URL).toBe(
      'https://ai.claudia.ru/api/oauth/claude_cli/roles',
    )
    expect(config.CLAUDE_AI_AUTHORIZE_URL).toBe(
      'https://ai.claudia.ru/oauth/authorize',
    )
    expect(isHostManagedExternalInference()).toBe(true)
  })

  test('does not classify a shared control and inference origin as split routing', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://ai.claudia.ru/v1'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.claudia.ru'

    expect(isHostManagedExternalInference()).toBe(false)
  })
})
