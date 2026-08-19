import type { ServerApprovalWatch } from '../../types/permissions.js'
import { sleep } from '../../utils/sleep.js'

export type ServerApprovalObserver = {
  poll(): Promise<boolean>
}

export type ServerApprovalWatchProvider = {
  isEnabled(): boolean
  createObserver(
    descriptor: ServerApprovalWatch,
  ): ServerApprovalObserver | null
}

let provider: ServerApprovalWatchProvider | null = null

/**
 * Claude Code 2.1.221 has one process-wide product observer provider. Product
 * surfaces register their descriptor dispatcher during module initialization.
 */
export function registerServerApprovalWatchProvider(
  next: ServerApprovalWatchProvider,
): void {
  provider = next
}

export function getServerApprovalWatchProvider(): ServerApprovalWatchProvider | null {
  return provider
}

export type RunServerApprovalWatchOptions = {
  signal: AbortSignal
  isResolved(): boolean
  isPlanMode(): boolean
  onParked(): void
  onObserved(): void | Promise<void>
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

/**
 * Run the exact 2.1.221 approval race: seed with an immediate poll, then use a
 * 3s exponential backoff (rounded, capped at 15s). An approval observed while
 * the session is in plan mode is parked and polling continues.
 */
export async function runServerApprovalWatch(
  observer: ServerApprovalObserver,
  options: RunServerApprovalWatchOptions,
): Promise<void> {
  let observed = await observer.poll()
  let delayMs = 3000
  const maxDelayMs = 15_000
  while (
    !observed &&
    !options.isResolved() &&
    !options.signal.aborted
  ) {
    await (options.wait ?? sleep)(delayMs, options.signal)
    if (options.isResolved() || options.signal.aborted) return
    observed = await observer.poll()
    if (!observed) {
      delayMs = Math.min(Math.round(delayMs * 1.5), maxDelayMs)
      continue
    }
    if (options.isPlanMode()) {
      options.onParked()
      observed = false
      delayMs = Math.min(Math.round(delayMs * 1.5), maxDelayMs)
      continue
    }
    await options.onObserved()
    return
  }
}

export function resetServerApprovalWatchProviderForTests(): void {
  provider = null
}
