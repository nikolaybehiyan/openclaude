import type { AppState } from '../state/AppState.js'
import type { SetAppState } from '../Task.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { isLocalAgentKeptAlive, isLocalAgentTask, type LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { reconcileWorkflowOwnerLeases } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { enqueuePendingNotification, getCommandQueue, remove } from './messageQueueManager.js'

type StateAccess = { getAppState: () => AppState; setAppState: SetAppState }

/** Shared by the running-query drain and the idle-owner delivery commit. */
export function reconcileConsumedWorkflowNotifications(commands: readonly QueuedCommand[], context: StateAccess): void {
  const owners = new Set(commands.filter(c => c.mode === 'task-notification' && c.taskId && c.agentId).map(c => c.agentId!))
  for (const owner of owners) {
    const pending = new Set(getCommandQueue().filter(c => c.mode === 'task-notification' && c.agentId === owner && c.taskId).map(c => c.taskId!))
    reconcileWorkflowOwnerLeases(owner, pending, context.setAppState)
  }
}

export type WorkflowOwnerWakeRequest = {
  agentId: string
  prompt: string
  expectedTask: LocalAgentTaskState
  onDeliveryCommitted: () => void
}

/** Official EFi/Eoh wake routing, using the existing AppState/command queue. */
export function createWorkflowOwnerWakeRouter(context: StateAccess & {
  resume: (request: WorkflowOwnerWakeRequest) => Promise<unknown>
  onError: (error: unknown) => void
  retryDelayMs?: number
}) {
  const inFlight = new Set<string>()
  const retryAfter = new Map<string, number>()
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function scheduleRetry() {
    if (disposed || retryTimer !== undefined || !retryAfter.size) return
    const delay = Math.max(1, Math.min(...retryAfter.values()) - Date.now())
    retryTimer = setTimeout(() => { retryTimer = undefined; void flush() }, delay)
    retryTimer.unref?.()
  }

  async function flush(): Promise<void> {
    if (disposed) return
    const groups = new Map<string, QueuedCommand[]>()
    for (const command of getCommandQueue()) {
      if (command.mode !== 'task-notification' || !command.agentId || !command.taskId) continue
      const group = groups.get(command.agentId) ?? []
      group.push(command); groups.set(command.agentId, group)
    }
    // A failed/stopped/removed owner can no longer receive its result; keep
    // the result available on the main thread instead of silently dropping it.
    const jobs: Promise<unknown>[] = []
    for (const [agentId, commands] of groups) {
      if (inFlight.has(agentId)) continue
      const owner = context.getAppState().tasks[agentId]
      if (isLocalAgentTask(owner) && owner.status === 'running') {
        // A normal SendMessage/resume may have won after an earlier setup
        // failure. Its running query now owns delivery; an expired retry must
        // not keep scheduling this router every millisecond.
        retryAfter.delete(agentId)
        continue
      }
      if (!isLocalAgentKeptAlive(owner) || owner.stoppedByUser) {
        remove(commands)
        for (const command of commands) enqueuePendingNotification({ ...command, agentId: undefined })
        reconcileConsumedWorkflowNotifications(commands, context)
        retryAfter.delete(agentId)
        continue
      }
      if ((retryAfter.get(agentId) ?? 0) > Date.now()) continue
      retryAfter.delete(agentId)
      inFlight.add(agentId)
      let committed = false
      const job = Promise.resolve().then(() => context.resume({
        agentId, expectedTask: owner,
        prompt: commands.map(c => typeof c.value === 'string' ? c.value : '').filter(Boolean).join('\n\n'),
        onDeliveryCommitted() {
          if (committed) return
          committed = true
          remove(commands)
          reconcileConsumedWorkflowNotifications(commands, context)
        },
      })).catch(error => {
        context.onError(error)
        if (!committed) retryAfter.set(agentId, Date.now() + (context.retryDelayMs ?? 5000))
      }).finally(() => {
        inFlight.delete(agentId)
        // Removal is an acknowledgement, not a pre-dispatch dequeue. Failed
        // setup retains commands for retry; new arrivals remain independent.
        if (committed && !disposed) queueMicrotask(() => { void flush() })
        scheduleRetry()
      })
      jobs.push(job)
    }
    for (const id of retryAfter.keys()) if (!groups.has(id)) retryAfter.delete(id)
    scheduleRetry()
    await Promise.all(jobs)
  }

  return { flush, dispose() { disposed = true; if (retryTimer !== undefined) clearTimeout(retryTimer); retryAfter.clear() } }
}
