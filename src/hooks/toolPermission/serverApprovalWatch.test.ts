import { beforeEach, describe, expect, test } from 'bun:test'
import {
  getServerApprovalWatchProvider,
  registerServerApprovalWatchProvider,
  resetServerApprovalWatchProviderForTests,
  runServerApprovalWatch,
  type ServerApprovalObserver,
} from './serverApprovalWatch.js'

beforeEach(() => {
  resetServerApprovalWatchProviderForTests()
})

describe('server approval watch core', () => {
  test('owns one process-wide product observer provider', () => {
    const observer: ServerApprovalObserver = { poll: async () => false }
    const provider = {
      isEnabled: () => true,
      createObserver: () => observer,
    }
    registerServerApprovalWatchProvider(provider)
    expect(getServerApprovalWatchProvider()).toBe(provider)
  })

  test('polls immediately then uses exact rounded exponential backoff', async () => {
    const results = [false, false, false, true]
    const delays: number[] = []
    let observed = 0
    await runServerApprovalWatch(
      { poll: async () => results.shift() ?? false },
      {
        signal: new AbortController().signal,
        isResolved: () => false,
        isPlanMode: () => false,
        onParked: () => {
          throw new Error('must not park')
        },
        onObserved: () => {
          observed++
        },
        wait: async milliseconds => {
          delays.push(milliseconds)
        },
      },
    )
    expect(delays).toEqual([3000, 4500, 6750])
    expect(observed).toBe(1)
  })

  test('parks an observed grant in plan mode and keeps polling', async () => {
    const results = [false, true, false, true]
    const delays: number[] = []
    let planMode = true
    let parked = 0
    let observed = 0
    await runServerApprovalWatch(
      { poll: async () => results.shift() ?? false },
      {
        signal: new AbortController().signal,
        isResolved: () => false,
        isPlanMode: () => planMode,
        onParked: () => {
          parked++
          planMode = false
        },
        onObserved: () => {
          observed++
        },
        wait: async milliseconds => {
          delays.push(milliseconds)
        },
      },
    )
    expect(delays).toEqual([3000, 4500, 6750])
    expect(parked).toBe(1)
    expect(observed).toBe(1)
  })

  test('stops without another poll after abort during backoff', async () => {
    const abort = new AbortController()
    let polls = 0
    await runServerApprovalWatch(
      {
        poll: async () => {
          polls++
          return false
        },
      },
      {
        signal: abort.signal,
        isResolved: () => false,
        isPlanMode: () => false,
        onParked: () => {},
        onObserved: () => {},
        wait: async () => {
          abort.abort()
        },
      },
    )
    expect(polls).toBe(1)
  })
})
