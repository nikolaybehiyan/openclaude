import { AsyncLocalStorage } from 'node:async_hooks'

// A background context report must not refresh credentials or send inference
// requests. Scope this to its async work, not to the concurrent conversation.
const localContextCounts = new AsyncLocalStorage<boolean>()

export function withLocalContextTokenCounts<T>(work: () => T): T {
  return localContextCounts.run(true, work)
}

export function usesLocalContextTokenCounts(): boolean {
  return localContextCounts.getStore() === true
}
