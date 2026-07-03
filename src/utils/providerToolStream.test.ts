import { describe, expect, test } from 'bun:test'
import {
  isZaiToolStreamCapableGLM,
  shouldEnableProviderToolStream,
} from './providerToolStream.js'

describe('provider tool streaming', () => {
  test('enables Z.AI tool_stream for GLM-4.6+ and GLM-5 streaming tool calls', () => {
    const baseUrl = 'https://api.z.ai/api/anthropic'

    expect(
      shouldEnableProviderToolStream({
        baseUrl,
        hasTools: true,
        model: 'glm-5-turbo',
        stream: true,
      }),
    ).toBe(true)
    expect(
      shouldEnableProviderToolStream({
        baseUrl,
        hasTools: true,
        model: 'GLM-4.7',
        stream: true,
      }),
    ).toBe(true)
  })

  test('keeps tool_stream off when provider, tools, stream, or model support do not match', () => {
    expect(isZaiToolStreamCapableGLM('GLM-4.5-Air')).toBe(false)
    expect(isZaiToolStreamCapableGLM('glm-50')).toBe(false)

    expect(
      shouldEnableProviderToolStream({
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        hasTools: true,
        model: 'glm-5-turbo',
        stream: true,
      }),
    ).toBe(false)
    expect(
      shouldEnableProviderToolStream({
        baseUrl: 'https://api.z.ai/api/anthropic',
        hasTools: false,
        model: 'glm-5-turbo',
        stream: true,
      }),
    ).toBe(false)
    expect(
      shouldEnableProviderToolStream({
        baseUrl: 'https://api.z.ai/api/anthropic',
        hasTools: true,
        model: 'glm-5-turbo',
        stream: false,
      }),
    ).toBe(false)
  })
})
