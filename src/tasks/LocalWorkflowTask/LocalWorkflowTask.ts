import { createTaskStateBase, type SetAppState, type Task } from '../../Task.js'
import { getIsInteractive } from '../../bootstrap/state.js'
import type { AgentId } from '../../types/ids.js'
import { createAbortController } from '../../utils/abortController.js'
import { logError } from '../../utils/log.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import { appendTaskOutput, evictTaskOutput, initTaskOutput } from '../../utils/task/diskOutput.js'
import { PANEL_GRACE_MS, registerTask, updateTaskState } from '../../utils/task/framework.js'
import type { LocalWorkflowTaskState, WorkflowProgress, WorkflowTerminal } from './types.js'
import { acquireLocalAgentKeepalive, isLocalAgentKeptAlive, isLocalAgentTask, releaseLocalAgentKeepalive } from '../LocalAgentTask/LocalAgentTask.js'

export type { LocalWorkflowTaskState, WorkflowProgress, SdkWorkflowProgress } from './types.js'
export { createWorkflowProgressBatcher } from './progressBatcher.js'

export function isLocalWorkflowTask(task: unknown): task is LocalWorkflowTaskState {
  return task != null && typeof task === 'object' && 'type' in task && task.type === 'local_workflow'
}

function registerUnique(task: LocalWorkflowTaskState, setAppState: SetAppState) {
  // IDs belong to one execution. Do not replace a live owner with a late adopt
  // or resume snapshot; new executions receive a new ID from the runner.
  registerTask(task, update => setAppState(prev => {
    if (prev.tasks[task.id]) throw new Error(`Workflow task already registered: ${task.id}`)
    return update(prev)
  }))
}

export function registerWorkflowTask(input: {
  taskId: string
  script: string
  scriptPath?: string
  args?: unknown
  summary?: string
  workflowName?: string
  title?: string
  phases?: LocalWorkflowTaskState['phases']
  defaultModel?: string
  workflowRunId: string
  ownerAgentId?: AgentId
  setAppState: SetAppState
  toolUseId?: string
  startTime?: number
}): LocalWorkflowTaskState {
  const { taskId, setAppState, startTime, ...fields } = input
  const output = Promise.withResolvers<string>()
  const task: LocalWorkflowTaskState = {
    ...createTaskStateBase(taskId, 'local_workflow', input.summary ?? 'Dynamic workflow', input.toolUseId),
    ...fields,
    ...(startTime !== undefined && { startTime }),
    type: 'local_workflow', status: 'running', prompt: input.script,
    workflowProgress: [], progressVersion: 0, agentCount: 0,
    totalTokens: 0, totalToolCalls: 0, logs: [],
    abortController: createAbortController(0), agentControllers: new Map(),
    outputReady: output.promise,
  }
  void output.promise.catch(logError)
  registerUnique(task, setAppState)
  if (getIsInteractive()) acquireLocalAgentKeepalive(task.ownerAgentId, `workflow:${taskId}`, setAppState)
  void initTaskOutput(taskId).then(output.resolve, output.reject)
  return task
}

export function registerAdoptedWorkflowTask(input: {
  taskId: string; description: string; scriptPath?: string; workflowRunId: string; startTime?: number
}, setAppState: SetAppState): LocalWorkflowTaskState {
  const base = createTaskStateBase(input.taskId, 'local_workflow', input.description)
  const task: LocalWorkflowTaskState = {
    ...base, startTime: input.startTime ?? base.startTime, type: 'local_workflow', status: 'paused',
    script: '', prompt: '', scriptPath: input.scriptPath, workflowRunId: input.workflowRunId,
    workflowProgress: [], progressVersion: 0, agentCount: 0,
    totalTokens: 0, totalToolCalls: 0, logs: [], notified: true,
  }
  registerUnique(task, setAppState)
  return task
}

export function updateWorkflowProgressBatch(taskId: string, batch: readonly WorkflowProgress[], setAppState: SetAppState): void {
  if (!batch.length) return
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (!isLocalWorkflowTask(task) || task.status !== 'running') return task
    let progress = [...task.workflowProgress]
    const positions = new Map<string, number>()
    progress.forEach((item, index) => {
      if (item.type !== 'workflow_log') positions.set(`${item.type}:${item.index}`, index)
    })
    let agentCount = task.agentCount, addedLog = false
    for (const item of batch) {
      if (item.type === 'workflow_log') {
        progress.push(item); addedLog = true
      } else {
        const key = `${item.type}:${item.index}`, position = positions.get(key)
        if (position !== undefined) progress[position] = item
        else { positions.set(key, progress.length); progress.push(item) }
        if (item.type === 'workflow_agent' && item.state === 'start') agentCount = Math.max(agentCount, item.index)
      }
    }
    if (addedLog && progress.length > 1000) {
      let discard = progress.length - 500
      progress = progress.filter(item => !(item.type === 'workflow_log' && discard-- > 0))
    }
    let totalTokens = 0, totalToolCalls = 0
    for (const item of progress) if (item.type === 'workflow_agent') {
      totalTokens += item.tokens || 0; totalToolCalls += item.toolCalls || 0
    }
    return { ...task, workflowProgress: progress, progressVersion: task.progressVersion + batch.length,
      agentCount, totalTokens, totalToolCalls }
  })
}

function transition(taskId: string, setAppState: SetAppState, status: 'completed' | 'failed' | 'killed' | 'paused',
  values: Partial<LocalWorkflowTaskState> = {}): LocalWorkflowTaskState | undefined {
  let prior: LocalWorkflowTaskState | undefined
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (!isLocalWorkflowTask(task) || task.status !== 'running') return task
    prior = task
    const now = Date.now()
    return { ...task, ...values, status, endTime: now,
      ...(status !== 'paused' && { evictAfter: now + PANEL_GRACE_MS }),
      abortController: undefined, agentControllers: undefined }
  })
  // Publish first: abort listeners may synchronously try to fail/finish this
  // task. They must observe its new state and cannot overwrite its outcome.
  if (prior) {
    prior.abortController?.abort()
    for (const controller of prior.agentControllers?.values() ?? []) controller.abort()
    prior.agentControllers?.clear()
  }
  return prior
}

function writeOutput(task: LocalWorkflowTaskState, value: unknown) {
  const content = JSON.stringify(value, null, 2) + '\n'
  void (task.outputReady ?? Promise.resolve(task.outputFile)).then(async () => {
    appendTaskOutput(task.id, content)
    await evictTaskOutput(task.id)
  }).catch(logError)
}

export function completeWorkflowTask(taskId: string, result: unknown, agentCount: number, logs: string[],
  setAppState: SetAppState, terminal?: WorkflowTerminal): boolean {
  const prior = transition(taskId, setAppState, 'completed', { result, agentCount, logs, terminal })
  if (!prior) return false
  writeOutput(prior, { summary: prior.summary, agentCount, logs, result,
    workflowProgress: prior.workflowProgress.filter(item => item.type !== 'workflow_log'),
    totalTokens: prior.totalTokens, totalToolCalls: prior.totalToolCalls })
  return true
}

export function failWorkflowTask(taskId: string, error: string, agentCount: number, logs: string[],
  setAppState: SetAppState, terminal?: WorkflowTerminal): boolean {
  const prior = transition(taskId, setAppState, 'failed', { error, agentCount, logs, terminal })
  if (!prior) return false
  writeOutput(prior, { summary: prior.summary, error, agentCount, logs,
    workflowProgress: prior.workflowProgress.filter(item => item.type !== 'workflow_log'),
    totalTokens: prior.totalTokens, totalToolCalls: prior.totalToolCalls })
  return true
}

export function pauseWorkflowTask(taskId: string, setAppState: SetAppState): boolean {
  const prior = transition(taskId, setAppState, 'paused', { notified: true })
  if (!prior) return false
  releaseLocalAgentKeepalive(prior.ownerAgentId, `workflow:${taskId}`, setAppState)
  return true
}

export function killWorkflowTask(taskId: string, setAppState: SetAppState): boolean {
  const prior = transition(taskId, setAppState, 'killed', { notified: true, notificationDelivery: 'sdk' })
  if (!prior) return false
  releaseLocalAgentKeepalive(prior.ownerAgentId, `workflow:${taskId}`, setAppState)
  emitTaskTerminatedSdk(taskId, 'stopped', { toolUseId: prior.toolUseId,
    summary: prior.description, outputFile: prior.outputFile })
  void evictTaskOutput(taskId)
  return true
}

function interruptAgent(taskId: string, agentId: string, reason: 'user-skip' | 'user-retry', setAppState: SetAppState): boolean {
  let controller: AbortController | undefined
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (isLocalWorkflowTask(task) && task.status === 'running') controller = task.agentControllers?.get(agentId)
    return task
  })
  if (!controller || controller.signal.aborted) return false
  controller.abort(new DOMException(reason, 'AbortError'))
  return true
}

export const skipWorkflowAgent = (taskId: string, agentId: string, setAppState: SetAppState) => interruptAgent(taskId, agentId, 'user-skip', setAppState)
export const retryWorkflowAgent = (taskId: string, agentId: string, setAppState: SetAppState) => interruptAgent(taskId, agentId, 'user-retry', setAppState)

/** Called after the owner's query consumes notifications (official ajt). */
export function reconcileWorkflowOwnerLeases(ownerId: string, pendingTaskIds: ReadonlySet<string>, setAppState: SetAppState): void {
  const release: string[] = []
  setAppState(state => {
    const owner = state.tasks[ownerId]
    if (isLocalAgentTask(owner)) for (const reason of owner.keepaliveReasons ?? []) {
      if (!reason.startsWith('workflow:')) continue
      const id = reason.slice('workflow:'.length)
      const child = state.tasks[id]
      if (!pendingTaskIds.has(id) && (!child || isLocalWorkflowTask(child) && child.notified)) release.push(reason)
    }
    return state
  })
  for (const reason of release) releaseLocalAgentKeepalive(ownerId, reason, setAppState)
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!))

export function buildResumePrompt(task: { scriptPath?: string; workflowRunId: string; args?: unknown }): string {
  const args = task.args !== undefined ? `, args: ${JSON.stringify(task.args)}` : ''
  return `Resume the paused workflow by calling: Workflow({scriptPath: ${JSON.stringify(task.scriptPath)}, resumeFromRunId: ${JSON.stringify(task.workflowRunId)}${args}}) — completed agents return cached results.`
}

export function enqueueWorkflowNotification(input: {
  taskId: string; setAppState: SetAppState; summary?: string; status: 'completed' | 'failed' | 'killed'
  result?: unknown; failures?: string[]; error?: string; agentCount: number
  totalTokens: number; totalToolCalls: number; durationMs: number; toolUseId?: string
  transcriptDir?: string; scriptPath?: string; workflowRunId?: string; args?: unknown
  workflowProgress?: readonly WorkflowProgress[]; suppressCompletionNotification?: boolean
}): boolean {
  let claimed: LocalWorkflowTaskState | undefined
  let delivery: 'sdk' | 'xml' = 'xml'
  let destination: AgentId | undefined
  input.setAppState(state => {
    const task = state.tasks[input.taskId]
    if (!isLocalWorkflowTask(task) || task.status !== input.status || task.notificationDelivery) return state
    claimed = task
    // TaskOutput may have consumed the result first. The SDK still needs its
    // closing bookend, but the model must not receive the same result twice.
    delivery = task.notified || input.suppressCompletionNotification ? 'sdk' : 'xml'
    const owner = task.ownerAgentId ? state.tasks[task.ownerAgentId] : undefined
    if (isLocalAgentTask(owner) && (owner.status === 'running' || getIsInteractive() && isLocalAgentKeptAlive(owner))) destination = task.ownerAgentId
    return { ...state, tasks: { ...state.tasks, [task.id]: { ...task, notified: true, notificationDelivery: delivery } } }
  })
  if (!claimed) return false
  if (delivery === 'sdk' || !destination) releaseLocalAgentKeepalive(claimed.ownerAgentId, `workflow:${input.taskId}`, input.setAppState)
  const summary = input.summary ?? 'Dynamic workflow'
  const description = input.status === 'completed' ? `Dynamic workflow "${summary}" completed`
    : input.status === 'failed' ? `Dynamic workflow "${summary}" failed: ${input.error || 'Unknown error'}`
    : `Dynamic workflow "${summary}" was stopped`
  if (delivery === 'sdk') {
    emitTaskTerminatedSdk(input.taskId, input.status === 'killed' ? 'stopped' : input.status,
      { toolUseId: input.toolUseId ?? claimed.toolUseId, summary: description, outputFile: claimed.outputFile,
        usage: { total_tokens: input.totalTokens, tool_uses: input.totalToolCalls, duration_ms: input.durationMs } })
    return true
  }
  let body = ''
  if (input.status === 'completed' && input.result !== undefined) {
    const result = escapeXml(JSON.stringify(input.result))
    body += `\n<result>${result.slice(0, 8000)}${result.length > 8000 ? `\n... (truncated ${result.length - 8000} chars, full result in ${claimed.outputFile})` : ''}</result>`
  }
  if (input.failures?.length) body += `\n<failures>${escapeXml(input.failures.join('\n'))}</failures>`
  if (input.scriptPath && input.workflowRunId) body += `\n<recovery>${escapeXml(buildResumePrompt({ scriptPath: input.scriptPath, workflowRunId: input.workflowRunId, args: input.args }))}</recovery>`
  if (input.transcriptDir) body += `\n<diagnostics>${escapeXml(`Per-agent results: ${input.transcriptDir}/journal.jsonl. Read before diagnosing an empty result; cached results may be empty.`)}</diagnostics>`
  let done = 0, errors = 0, skipped = 0, empty = 0
  for (const item of input.workflowProgress ?? []) if (item.type === 'workflow_agent') {
    if (item.state === 'done') { done++; if (item.resultPreview === undefined || /^(\[\s*\]|\{\s*\}|\{\s*"[^"]+"\s*:\s*\[\s*\]\s*\})$/.test(item.resultPreview)) empty++ }
    else if (item.state === 'error') { if (item.skipped) skipped++; else errors++ }
  }
  body += `\n<usage><agent_count>${input.agentCount}</agent_count><agents_done>${done}</agents_done><agents_error>${errors}</agents_error><agents_skipped>${skipped}</agents_skipped><agents_empty_result>${empty}</agents_empty_result><subagent_tokens>${input.totalTokens}</subagent_tokens><total_tokens>${input.totalTokens}</total_tokens><tool_uses>${input.totalToolCalls}</tool_uses><duration_ms>${input.durationMs}</duration_ms></usage>`
  const toolUseId = input.toolUseId ?? claimed.toolUseId
  enqueuePendingNotification({
    value: `<task-notification>\n<task-id>${escapeXml(input.taskId)}</task-id>${toolUseId ? `\n<tool-use-id>${escapeXml(toolUseId)}</tool-use-id>` : ''}\n<output-file>${escapeXml(claimed.outputFile)}</output-file>\n<status>${input.status}</status>\n<summary>${escapeXml(description)}</summary>${body}\n</task-notification>`,
    mode: 'task-notification', priority: 'next', agentId: destination, taskId: input.taskId,
  })
  return true
}

export const LocalWorkflowTask: Task = { name: 'LocalWorkflowTask', type: 'local_workflow',
  async kill(taskId, setAppState) { killWorkflowTask(taskId, setAppState) } }
