import { describe, expect, test } from 'bun:test'
import { isValidSessionTitle } from './sessionTitle.js'

describe('session title word limit', () => {
  test('accepts exactly three or four words', () => {
    expect(isValidSessionTitle('Fix plugin lifecycle')).toBe(true)
    expect(isValidSessionTitle('Fix plugin lifecycle state')).toBe(true)
  })

  test('rejects shorter and longer titles', () => {
    expect(isValidSessionTitle('Plugin lifecycle')).toBe(false)
    expect(isValidSessionTitle('Fix the broken plugin lifecycle')).toBe(false)
  })
})
