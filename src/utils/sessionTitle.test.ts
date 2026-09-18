import { describe, expect, test } from 'bun:test'
import { isValidSessionTitle } from './sessionTitle.js'

describe('session title word limit', () => {
  test('accepts short one- and two-word titles', () => {
    expect(isValidSessionTitle('Authentication')).toBe(true)
    expect(isValidSessionTitle('Plugin lifecycle')).toBe(true)
    expect(isValidSessionTitle('Приветствие')).toBe(true)
    expect(isValidSessionTitle('Проверка подключения')).toBe(true)
  })

  test('accepts three or four words', () => {
    expect(isValidSessionTitle('Fix plugin lifecycle')).toBe(true)
    expect(isValidSessionTitle('Fix plugin lifecycle state')).toBe(true)
  })

  test('counts words without surrounding or repeated whitespace', () => {
    expect(isValidSessionTitle('  Подключение  ')).toBe(true)
    expect(isValidSessionTitle('\tПроверка\u00a0\u00a0подключения\n')).toBe(true)
  })

  test('rejects empty titles', () => {
    expect(isValidSessionTitle('')).toBe(false)
    expect(isValidSessionTitle(' \t\n\u00a0')).toBe(false)
  })

  test('rejects more than four words', () => {
    expect(isValidSessionTitle('Fix the broken plugin lifecycle')).toBe(false)
    expect(isValidSessionTitle('Проверка подключения к новой модели')).toBe(false)
  })
})
