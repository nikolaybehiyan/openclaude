import { afterEach, describe, expect, test } from 'bun:test'
import { appendSubagentPrompt } from './subagentPrompt.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

const gate = 'CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT'
const previous = process.env[gate]
afterEach(() => {
  if (previous === undefined) delete process.env[gate]
  else process.env[gate] = previous
})

describe('2.1.221 Task subagent system prompt', () => {
  test('requires the explicit reference environment gate', () => {
    const base = asSystemPrompt(['AGENT', 'ENV'])
    for (const value of [undefined, '0', 'false']) {
      if (value === undefined) delete process.env[gate]
      else process.env[gate] = value
      expect(appendSubagentPrompt(base, 'DEVICE_CONTEXT', false)).toBe(base)
    }
  })
  test('appends one ordered section, without mutating the base', () => {
    process.env[gate] = '1'
    const base = asSystemPrompt(['AGENT', 'ENV'])
    expect(appendSubagentPrompt(base, 'DEVICE_CONTEXT', false)).toEqual(['AGENT', 'ENV', 'DEVICE_CONTEXT'])
    expect(base).toEqual(['AGENT', 'ENV'])
  })
  test('empty and absent appends preserve the original prompt', () => {
    process.env[gate] = '1'
    const base = asSystemPrompt(['AGENT'])
    expect(appendSubagentPrompt(base, '', false)).toBe(base)
    expect(appendSubagentPrompt(base, undefined, false)).toBe(base)
  })
  test('fork preserves the exact parent prefix even with the gate enabled', () => {
    process.env[gate] = '1'
    const parent = asSystemPrompt(['COWORK', 'DEVICE_CONTEXT'])
    expect(appendSubagentPrompt(parent, 'DEVICE_CONTEXT', true)).toBe(parent)
  })
})
