import { afterEach, describe, expect, test } from 'bun:test'
import { getClaudeAiBaseUrl } from './product.js'

const originalCustomOauthUrl = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL

afterEach(() => {
  if (originalCustomOauthUrl === undefined) {
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  } else {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = originalCustomOauthUrl
  }
})

describe('getClaudeAiBaseUrl', () => {
  test('uses the centrally configured owned origin for production sessions', () => {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.claudia.ru'
    expect(getClaudeAiBaseUrl('session_prod_123')).toBe(
      'https://ai.claudia.ru',
    )
  })

  test('preserves explicit local and staging session routing', () => {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.claudia.ru'
    expect(getClaudeAiBaseUrl('session_local_123')).toBe(
      'http://localhost:4000',
    )
    expect(getClaudeAiBaseUrl('session_staging_123')).toBe(
      'https://claude-ai.staging.ant.dev',
    )
  })
})
