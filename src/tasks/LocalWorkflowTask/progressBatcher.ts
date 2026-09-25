import type { WorkflowProgress } from './types.js'

/** Official 2.1.226 dUb: batch state updates, separately throttle hidden TUI. */
export function createWorkflowProgressBatcher(options: {
  onBatch: (batch: WorkflowProgress[]) => void
  onSdkEmit: (batch: WorkflowProgress[]) => void
  isNonInteractive?: () => boolean
  isBackground?: () => boolean
}) {
  let pending: WorkflowProgress[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastBackgroundFlush = 0
  const nonInteractive = options.isNonInteractive ?? (() => true)
  const background = options.isBackground ?? (() => false)

  function flush(forced = false) {
    timer = undefined
    if (!pending.length) return
    if (!forced && !nonInteractive() && background()) {
      const remaining = lastBackgroundFlush + 250 - Date.now()
      if (remaining > 0) {
        timer = setTimeout(flush, remaining)
        return
      }
      lastBackgroundFlush = Date.now()
    }
    const batch = pending
    pending = []
    options.onBatch(batch)
    if (nonInteractive() || background()) options.onSdkEmit(batch)
  }

  return {
    onProgress(progress: WorkflowProgress) {
      pending.push(progress)
      timer ??= setTimeout(flush, 16)
    },
    flushNow() {
      if (timer !== undefined) clearTimeout(timer)
      flush(true)
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = []
    },
  }
}
