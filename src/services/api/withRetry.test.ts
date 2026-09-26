import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import * as providers from '../../utils/model/providers.js'
import * as auth from '../../utils/auth.js'

// Helper to build a mock APIError with specific headers
function makeError(headers: Record<string, string>): APIError {
  const headersObj = new Headers(headers)
  return {
    headers: headersObj,
    status: 429,
    message: 'rate limit exceeded',
    name: 'APIError',
    error: {},
  } as unknown as APIError
}

// Save/restore env vars between tests
const originalEnv = { ...process.env }

const envKeys = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
] as const

beforeEach(() => {
  for (const key of envKeys) {
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  mock.restore()
})

async function importFreshWithRetryModule(
  provider:
    | 'firstParty'
    | 'openai'
    | 'github'
    | 'bedrock'
    | 'vertex'
    | 'gemini'
    | 'codex'
    | 'foundry' = 'firstParty',
) {
  mock.restore()
  mock.module('src/utils/model/providers.js', () => ({
    ...providers,
    getAPIProvider: () => provider,
    getAPIProviderForStatsig: () => provider,
  }))
  return import(`./withRetry.js?ts=${Date.now()}-${Math.random()}`)
}

// --- parseOpenAIDuration ---
describe('parseOpenAIDuration', () => {
  test('parses seconds: "1s" → 1000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('1s')).toBe(1000)
  })

  test('parses minutes+seconds: "6m0s" → 360000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('6m0s')).toBe(360000)
  })

  test('parses hours+minutes+seconds: "1h30m0s" → 5400000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('1h30m0s')).toBe(5400000)
  })

  test('parses milliseconds: "500ms" → 500', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('500ms')).toBe(500)
  })

  test('parses minutes only: "2m" → 120000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('2m')).toBe(120000)
  })

  test('returns null for empty string', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('')).toBeNull()
  })

  test('returns null for unrecognized format', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('invalid')).toBeNull()
  })
})

// --- getRateLimitResetDelayMs ---
describe('getRateLimitResetDelayMs - Anthropic (firstParty)', () => {
  test('reads anthropic-ratelimit-unified-reset Unix timestamp', async () => {
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('firstParty')
    const futureUnixSec = Math.floor(Date.now() / 1000) + 60
    const error = makeError({
      'anthropic-ratelimit-unified-reset': String(futureUnixSec),
    })
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).not.toBeNull()
    expect(delay!).toBeGreaterThan(50_000)
    expect(delay!).toBeLessThanOrEqual(60_000)
  })

  test('returns null when header absent', async () => {
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('firstParty')
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('returns null when reset is in the past', async () => {
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('firstParty')
    const pastUnixSec = Math.floor(Date.now() / 1000) - 10
    const error = makeError({
      'anthropic-ratelimit-unified-reset': String(pastUnixSec),
    })
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })
})

describe('getRateLimitResetDelayMs - OpenAI provider', () => {
  test('reads x-ratelimit-reset-requests duration string', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({ 'x-ratelimit-reset-requests': '30s' })
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).toBe(30_000)
  })

  test('reads x-ratelimit-reset-tokens and picks the larger delay', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({
      'x-ratelimit-reset-requests': '10s',
      'x-ratelimit-reset-tokens': '1m0s',
    })
    // Should use the larger of the two so we don't retry before both reset
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).toBe(60_000)
  })

  test('returns null when no openai rate limit headers present', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('works for github provider too', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('github')
    const error = makeError({ 'x-ratelimit-reset-requests': '5s' })
    expect(getRateLimitResetDelayMs(error)).toBe(5_000)
  })
})

describe('getRateLimitResetDelayMs - providers without reset headers', () => {
  test('returns null for bedrock', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('bedrock')
    const error = makeError({ 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 60) })
    // Bedrock doesn't use this header — should still return null
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('returns null for vertex', async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('vertex')
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })
})

describe('Darb temporary allowance reservation for Pro subscribers', () => {
  async function retryModule() {
    mock.module('../../utils/auth.js', () => ({
      ...auth,
      isClaudeAISubscriber: () => true,
      isEnterpriseSubscriber: () => false,
    }))
    return importFreshWithRetryModule()
  }

  function heldError(overrides: {
    status?: number, message?: string, type?: string, retry?: string | null, delay?: string | null,
  } = {}) {
    const headers = new Headers()
    const retry = overrides.retry === undefined ? 'true' : overrides.retry
    const delay = overrides.delay === undefined ? '1' : overrides.delay
    if (retry !== null) headers.set('x-should-retry', retry)
    if (delay !== null) headers.set('retry-after', delay)
    return APIError.generate(overrides.status ?? 429, {
      type: 'error',
      error: {type: overrides.type ?? 'rate_limit_error', message: overrides.message ?? 'usage_allowance_reserved'},
    }, undefined, headers)
  }

  const options = {model: 'deepseek-v4-pro', thinkingConfig: {type: 'disabled' as const}, maxRetries: 1}
  const client = async () => ({} as any)

  test('retries explicit temporary hold, preserving model and bounded delay', async () => {
    const {withRetry} = await retryModule()
    let calls = 0
    const loop = withRetry(client, async (_client, attempt, context) => {
      calls++
      expect(context.model).toBe(options.model)
      if (attempt === 1) throw heldError()
      return 'accepted'
    }, options)
    const wait = await loop.next()
    expect(wait.done).toBe(false)
    expect(wait.value).toMatchObject({retryInMs: 1000, retryAttempt: 1, maxRetries: 1})
    expect(await loop.next()).toEqual({done: true, value: 'accepted'})
    expect(calls).toBe(2)
  })

  for (const [name, overrides] of Object.entries({
    permanentBudget: {message: 'usage_allowance_exhausted'},
    generic429: {message: 'Inference usage limit exceeded'},
    requestDoesNotFit: {message: 'usage_allowance_exhausted', retry: 'false'},
    providerQuota: {message: 'exceeded your current quota'},
    retryDenied: {retry: 'false'},
    missingRetry: {retry: null},
    missingDelay: {delay: null},
    zeroDelay: {delay: '0'},
    longDelay: {delay: '31'},
    fractionalDelay: {delay: '1.5'},
    malformedDelay: {delay: '2seconds'},
    wrongErrorType: {type: 'api_error'},
    wrongStatus: {status: 400},
  })) {
    test(`keeps ${name} terminal`, async () => {
      const {withRetry, CannotRetryError} = await retryModule()
      let calls = 0
      const loop = withRetry(client, async () => {calls++; throw heldError(overrides)}, options)
      await expect(loop.next()).rejects.toBeInstanceOf(CannotRetryError)
      expect(calls).toBe(1)
    })
  }

  test('stops at existing retry budget', async () => {
    const {withRetry, CannotRetryError} = await retryModule()
    let calls = 0
    const loop = withRetry(client, async () => {calls++; throw heldError()}, options)
    expect((await loop.next()).done).toBe(false)
    await expect(loop.next()).rejects.toBeInstanceOf(CannotRetryError)
    expect(calls).toBe(2)
  })

  test('cancellation during retry wait prevents another wire attempt', async () => {
    const {withRetry} = await retryModule()
    const controller = new AbortController()
    let calls = 0
    const loop = withRetry(client, async () => {calls++; throw heldError()}, {...options, signal: controller.signal})
    expect((await loop.next()).done).toBe(false)
    controller.abort()
    await expect(loop.next()).rejects.toThrow('aborted')
    expect(calls).toBe(1)
  })

  test('never repeats an accepted operation', async () => {
    const {withRetry} = await retryModule()
    let calls = 0
    const loop = withRetry(client, async () => {calls++; return 'accepted'}, options)
    expect(await loop.next()).toEqual({done: true, value: 'accepted'})
    expect(calls).toBe(1)
  })
})
