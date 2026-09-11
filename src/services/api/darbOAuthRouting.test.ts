import { afterEach, expect, test } from 'bun:test'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { shouldUseFirstPartyAnthropicAuth } from './authRouting.js'

const keys = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_CUSTOM_OAUTH_URL'] as const
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})

test('Darb OAuth is available for its approved inference origin', () => {
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
  process.env.ANTHROPIC_BASE_URL = 'https://ai.darbmind.ru'
  expect(isFirstPartyAnthropicBaseUrl()).toBe(true)
  expect(shouldUseFirstPartyAnthropicAuth()).toBe(true)
  expect(shouldUseFirstPartyAnthropicAuth({
    model: 'external', baseURL: 'https://provider.example', apiKey: 'unused',
  })).toBe(false)
})

test.each([
  'https://provider.example',
  'https://ai.darbmind.ru.attacker.example',
  'http://ai.darbmind.ru',
  'https://ai.darbmind.ru:8443',
  'https://user:pass@ai.darbmind.ru',
])('Darb OAuth stays off unrelated inference origin %s', base => {
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
  process.env.ANTHROPIC_BASE_URL = base
  expect(isFirstPartyAnthropicBaseUrl()).toBe(false)
})

test('matching an unapproved custom origin cannot enable OAuth', () => {
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://provider.example'
  process.env.ANTHROPIC_BASE_URL = 'https://provider.example'
  expect(isFirstPartyAnthropicBaseUrl()).toBe(false)
})
