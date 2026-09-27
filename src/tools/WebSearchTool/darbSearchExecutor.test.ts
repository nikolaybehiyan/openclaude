import { describe, expect, test } from 'bun:test'
import type { DarbDefaultModel } from '../../utils/model/darbCatalog.js'
import { darbSearchExecutor } from './darbSearchExecutor.js'

const deepSeek = 'claude-darb-alibaba-deepseek-v4-pro'
const qwen = 'claude-darb-alibaba-qwen3-8-max'
const row = (id: string): DarbDefaultModel => ({
  id, display_name: id, type: 'model',
  native_parameters: {version: 1, thinking_types: ['disabled', 'enabled'], effort_values: []},
})

describe('Darb isolated search executor', () => {
  test('uses the qualified helper while preserving the selected model and catalog', () => {
    const catalog = Object.freeze([Object.freeze(row(deepSeek)), Object.freeze(row(qwen))])
    expect(darbSearchExecutor(deepSeek, catalog)).toBe(qwen)
    expect(darbSearchExecutor(deepSeek + '[1m]', catalog)).toBe(qwen)
    expect(catalog.map(model => model.id)).toEqual([deepSeek, qwen])
  })

  test('never infers authorization from a model-looking string or unavailable catalog', () => {
    expect(darbSearchExecutor(deepSeek, undefined)).toBeUndefined()
    expect(darbSearchExecutor(deepSeek, [row(qwen)])).toBeUndefined()
    expect(darbSearchExecutor('deepseek-v4-pro', [row('deepseek-v4-pro'), row(qwen)])).toBeUndefined()
  })

  test('preserves other native, Claude and custom model paths', () => {
    for (const model of [qwen, 'claude-darb-alibaba-glm-5-3', 'claude-sonnet-4-6', 'custom/model']) {
      expect(darbSearchExecutor(model, [row(deepSeek), row(qwen), row(model)])).toBeUndefined()
    }
  })

  test('does not silently use broken retrieval when the helper is unavailable', () => {
    expect(() => darbSearchExecutor(deepSeek, [row(deepSeek)])).toThrow('authenticated model catalog')
    expect(() => darbSearchExecutor(deepSeek, [row(deepSeek), {...row(qwen), native_parameters: undefined}])).toThrow()
    expect(() => darbSearchExecutor(deepSeek, [row(deepSeek), {...row(qwen), native_parameters: {
      version: 1, thinking_types: ['enabled'], effort_values: [],
    }}])).toThrow()
  })
})
