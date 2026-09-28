import { expect, test } from 'bun:test'
import { usesLocalContextTokenCounts, withLocalContextTokenCounts } from './contextTokenCountScope.js'

test('background count policy spans async descendants without changing concurrent inference', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const background = withLocalContextTokenCounts(async () => {
    await pending
    return Promise.all(Array.from({ length: 30 }, async () => {
      await Promise.resolve()
      return usesLocalContextTokenCounts()
    }))
  })
  expect(usesLocalContextTokenCounts()).toBe(false)
  await Promise.resolve()
  expect(usesLocalContextTokenCounts()).toBe(false)
  release()
  expect(await background).toEqual(Array(30).fill(true))
  expect(usesLocalContextTokenCounts()).toBe(false)
})

test('failed report releases its local count scope', async () => {
  await expect(withLocalContextTokenCounts(async () => {
    await Promise.resolve()
    throw new Error('fixture report failure')
  })).rejects.toThrow('fixture report failure')
  expect(usesLocalContextTokenCounts()).toBe(false)
})
