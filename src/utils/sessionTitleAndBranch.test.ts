import { describe, expect, test } from 'bun:test'
import {
  fallbackSessionTitleAndBranch,
  parseSessionTitleAndBranch,
} from './sessionTitleAndBranch.js'

describe('session title and branch parsing', () => {
  test('preserves the source-compatible JSON contract', () => {
    const fallback = fallbackSessionTitleAndBranch('Fallback task')
    expect(
      parseSessionTitleAndBranch(
        '{"title":"Fix mobile login","branch":"claude/fix-mobile-login"}',
        fallback,
      ),
    ).toEqual({
      title: 'Fix mobile login',
      branchName: 'claude/fix-mobile-login',
    })
  })

  test('falls back exactly like teleport for invalid output', () => {
    const fallback = fallbackSessionTitleAndBranch(
      'Investigate an invalid model response without losing the session title',
    )
    expect(parseSessionTitleAndBranch('not json', fallback)).toEqual(fallback)
    expect(parseSessionTitleAndBranch('{"title":"","branch":""}', fallback)).toEqual(
      fallback,
    )
  })
})
