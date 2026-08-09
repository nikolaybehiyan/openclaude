import { describe, expect, test } from 'bun:test'
import {
  getDefaultExternalAutoModeRules,
  resolveAutoModeRules,
} from '../../src/utils/permissions/yoloClassifier.js'

describe('Claude Code 2.1.221 auto-mode policy', () => {
  test('ships all four official default rule sections', () => {
    const defaults = getDefaultExternalAutoModeRules()
    expect(defaults.allow).toHaveLength(17)
    expect(defaults.soft_deny).toHaveLength(65)
    expect(defaults.hard_deny).toHaveLength(1)
    expect(defaults.environment).toHaveLength(20)
  })

  test('a configured section replaces defaults', () => {
    const resolved = resolveAutoModeRules({ allow: ['CUSTOM-A'] })
    expect(resolved.allow).toEqual(['CUSTOM-A'])
    expect(resolved.soft_deny).toHaveLength(65)
    expect(resolved.hard_deny).toHaveLength(1)
    expect(resolved.environment).toHaveLength(20)
  })

  test('$defaults expands once at its exact array position', () => {
    const defaults = getDefaultExternalAutoModeRules()
    const resolved = resolveAutoModeRules({
      allow: ['BEFORE', '$defaults', 'AFTER', '$defaults'],
    })
    expect(resolved.allow).toEqual([
      'BEFORE',
      ...defaults.allow,
      'AFTER',
    ])
  })

  test('an empty section inherits defaults', () => {
    expect(resolveAutoModeRules({ hard_deny: [] }).hard_deny).toHaveLength(1)
  })
})
