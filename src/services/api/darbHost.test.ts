import { afterEach, expect, test } from 'bun:test'
import { clearOAuthTokenCache } from '../../utils/auth.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { getAnthropicClient } from './client.js'

const originalEnv = { ...process.env }
const globals = globalThis as Record<string, unknown>
const originalMacro = globals.MACRO

afterEach(() => {
  process.env = { ...originalEnv }
  globals.MACRO = originalMacro
  clearOAuthTokenCache()
})

test('native Messages protocol and OAuth reach the Darb host unchanged', async () => {
  globals.MACRO = { VERSION: 'test-version' }
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('CLAUDE_CODE_USE_') || name.startsWith('ANTHROPIC_')) {
      delete process.env[name]
    }
  }
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
  process.env.ANTHROPIC_BASE_URL = 'https://ai.darbmind.ru'
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-darb-native-oauth'
  clearOAuthTokenCache()

  let requestUrl = ''
  let requestHeaders = new Headers()
  let requestBody: Record<string, unknown> = {}
  const client = await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
    fetchOverride: (async (input, init) => {
      requestUrl = String(input)
      requestHeaders = new Headers(init?.headers)
      requestBody = JSON.parse(String(init?.body))
      return Response.json({
        id: 'msg_test', type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }) as typeof fetch,
  })
  await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  })

  expect(requestUrl).toBe('https://ai.darbmind.ru/v1/messages')
  expect(requestHeaders.get('authorization')).toBe('Bearer test-darb-native-oauth')
  expect(requestHeaders.get('x-api-key')).toBeNull()
  expect(requestBody.model).toBe('claude-sonnet-4-6')
  expect(requestBody.messages).toEqual([{ role: 'user', content: 'hello' }])
})

test('the Darb host entry does not trust similarly named hosts', () => {
  for (const base of ['https://ai.darbmind.ru.evil.test', 'https://evil-ai.darbmind.ru']) {
    process.env.ANTHROPIC_BASE_URL = base
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)
  }
})
