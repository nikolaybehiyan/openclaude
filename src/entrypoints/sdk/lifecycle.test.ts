import { expect, test } from 'bun:test'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { unstable_shutdownRuntime } from './lifecycle.js'

test('SDK runtime shutdown waits for registered cleanup', async () => {
  let completed = false
  const unregister = registerCleanup(async () => {
    await Promise.resolve()
    completed = true
  })

  try {
    await unstable_shutdownRuntime()
    expect(completed).toBe(true)
  } finally {
    unregister()
  }
})
