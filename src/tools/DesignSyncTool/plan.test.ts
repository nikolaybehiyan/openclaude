import { beforeEach, describe, expect, test } from 'bun:test'
import {
  assertSafeDesignPath,
  isReservedDesignPath,
  normalizeDesignPath,
  pathAllowedByPlan,
  registerDesignPlan,
  requireDesignPlan,
  resetDesignPlansForTests,
} from './plan.js'

beforeEach(() => resetDesignPlansForTests())

describe('DesignSync path and plan boundary', () => {
  test('normalizes separators without erasing traversal', () => {
    expect(normalizeDesignPath('./cards\\button//index.html')).toBe(
      'cards/button/index.html',
    )
    expect(() => assertSafeDesignPath('../secret')).toThrow(
      'Invalid project path',
    )
    expect(() => assertSafeDesignPath(`ok\0secret`)).toThrow(
      'Invalid project path',
    )
    expect(() => assertSafeDesignPath('é'.repeat(129))).toThrow(
      'Invalid project path',
    )
  })

  test('blocks instruction paths case-insensitively', () => {
    expect(isReservedDesignPath('CLAUDE.md')).toBe(true)
    expect(isReservedDesignPath('.Claude/settings.json')).toBe(true)
    expect(isReservedDesignPath('components/CLAUDE.md')).toBe(false)
  })

  test('caps wildcard complexity and matches only approved paths', () => {
    expect(pathAllowedByPlan('cards/button.html', ['cards/*.html'])).toBe(true)
    expect(pathAllowedByPlan('cards/nested/button.html', ['cards/*.html'])).toBe(
      false,
    )
    expect(() =>
      pathAllowedByPlan('a/b/c/d.txt', ['**/**/**/**/d.txt']),
    ).toThrow('exceeds 3')
  })

  test('mints a project-bound 12-hex in-memory plan id', async () => {
    const id = await registerDesignPlan({
      projectId: 'Acme-Project_123456789',
      writes: ['cards/*.html'],
      deletes: ['old.html'],
    })
    expect(id).toMatch(/^plan_acmeproject12345_[a-f0-9]{12}$/)
    expect(requireDesignPlan(id, 'Acme-Project_123456789').writes).toEqual([
      'cards/*.html',
    ])
    expect(() => requireDesignPlan(id, 'different')).toThrow(
      'does not match this project',
    )
  })
})
