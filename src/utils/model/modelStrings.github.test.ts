import { afterEach, expect, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../settings/settingsCache.js'
import { normalizeModelStringForAPI, parseUserSpecifiedModel } from './model.js'
import {
  canonicalizeProviderModelResponse,
  getModelStrings,
  resolveOverriddenModel,
} from './modelStrings.js'

const originalEnv = {
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
  CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
  CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
}

function clearProviderFlags(): void {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
}

afterEach(() => {
  process.env.CLAUDE_CODE_USE_GITHUB = originalEnv.CLAUDE_CODE_USE_GITHUB
  process.env.CLAUDE_CODE_USE_OPENAI = originalEnv.CLAUDE_CODE_USE_OPENAI
  process.env.CLAUDE_CODE_USE_GEMINI = originalEnv.CLAUDE_CODE_USE_GEMINI
  process.env.CLAUDE_CODE_USE_BEDROCK = originalEnv.CLAUDE_CODE_USE_BEDROCK
  process.env.CLAUDE_CODE_USE_VERTEX = originalEnv.CLAUDE_CODE_USE_VERTEX
  process.env.CLAUDE_CODE_USE_FOUNDRY = originalEnv.CLAUDE_CODE_USE_FOUNDRY
  resetSettingsCache()
  resetModelStringsForTestingOnly()
})

test('GitHub provider model strings are concrete IDs', () => {
  clearProviderFlags()
  process.env.CLAUDE_CODE_USE_GITHUB = '1'

  const modelStrings = getModelStrings()

  for (const value of Object.values(modelStrings)) {
    expect(typeof value).toBe('string')
    expect(value.trim().length).toBeGreaterThan(0)
  }
})

test('GitHub provider model strings are safe to parse', () => {
  clearProviderFlags()
  process.env.CLAUDE_CODE_USE_GITHUB = '1'

  const modelStrings = getModelStrings()

  expect(() => parseUserSpecifiedModel(modelStrings.sonnet46 as any)).not.toThrow()
})

test('modelOverrides apply at provider API boundary', () => {
  setSessionSettingsCache({
    settings: {
      modelOverrides: {
        'claude-sonnet-4-6': 'glm-5-turbo',
      },
    },
    errors: [],
  })

  expect(normalizeModelStringForAPI('claude-sonnet-4-6')).toBe('glm-5-turbo')
  expect(normalizeModelStringForAPI('claude-sonnet-4-6[1m]')).toBe('glm-5-turbo')
})

test('modelOverrides restore the exact requested canonical model on responses', () => {
  setSessionSettingsCache({
    settings: {
      modelOverrides: {
        'claude-opus-5[1m]': 'glm-5.2',
        'claude-sonnet-5[1m]': 'glm-5.2',
        'claude-fable-5[1m]': 'glm-5.3',
      },
    },
    errors: [],
  })

  expect(resolveOverriddenModel('glm-5.2', 'claude-opus-5[1m]')).toBe(
    'claude-opus-5[1m]',
  )
  const providerResponse = {
    id: 'msg_1',
    model: 'glm-5.3',
    content: [{ type: 'text', text: 'hello' }],
  }
  const productResponse = canonicalizeProviderModelResponse(
    providerResponse,
    'claude-fable-5[1m]',
  )
  expect(productResponse).toEqual({
    ...providerResponse,
    model: 'claude-fable-5[1m]',
  })
  expect(providerResponse.model).toBe('glm-5.3')
})
