import { afterAll, afterEach, beforeEach, describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCwdState, setIsInteractive } from '../../bootstrap/state.js'
import { createTaskStateBase, generateTaskId, isTerminalTaskStatus, type SetAppState } from '../../Task.js'
import { asAgentId } from '../../types/ids.js'
import type { AppState } from '../../state/AppState.js'
import { TaskOutputTool } from '../../tools/TaskOutputTool/TaskOutputTool.js'
import { isBackgroundTask } from '../types.js'
import { clearCommandQueue, getCommandQueue } from '../../utils/messageQueueManager.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { _clearOutputsForTest, _resetTaskOutputDirForTest, flushTaskOutput, getTaskOutputDir } from '../../utils/task/diskOutput.js'
import { applyTaskOffsetsAndEvictions, evictTerminalTask, generateTaskAttachments, registerTask, updateTaskState } from '../../utils/task/framework.js'
import { completeWorkflowTask, createWorkflowProgressBatcher, enqueueWorkflowNotification,
  failWorkflowTask, killWorkflowTask, pauseWorkflowTask, registerAdoptedWorkflowTask,
  reconcileWorkflowOwnerLeases, registerWorkflowTask, retryWorkflowAgent, skipWorkflowAgent, updateWorkflowProgressBatch } from './LocalWorkflowTask.js'
import type { LocalWorkflowTaskState, WorkflowProgress } from './types.js'
import { acquireLocalAgentKeepalive, completeAgentTask, isLocalAgentKeptAlive, releaseLocalAgentKeepalive, type LocalAgentTaskState } from '../LocalAgentTask/LocalAgentTask.js'

const root = await mkdtemp(join(tmpdir(), 'darb-workflow-task-test-'))
setCwdState(root)
setIsInteractive(false)
_resetTaskOutputDirForTest()
const outputDirectory = getTaskOutputDir()
let state: AppState
const setAppState: SetAppState = update => { state = update(state) }
beforeEach(() => { setIsInteractive(false); state = { tasks: {} } as AppState; drainSdkEvents(); clearCommandQueue() })
afterEach(async () => { await _clearOutputsForTest(); clearCommandQueue(); drainSdkEvents() })
afterAll(async () => { await rm(outputDirectory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) })

async function start(ownerAgentId?: string) {
  const task = registerWorkflowTask({ taskId: generateTaskId('local_workflow'), script: 'return 42',
    workflowRunId: 'wf_owned-run', workflowName: 'owned', summary: 'Owned workflow', toolUseId: 'tool-owned',
    ownerAgentId: ownerAgentId ? asAgentId(ownerAgentId) : undefined, setAppState })
  await task.outputReady
  return task
}
const current = (task: LocalWorkflowTaskState) => state.tasks[task.id] as LocalWorkflowTaskState
const notice = (task: LocalWorkflowTaskState, status: 'completed' | 'failed' | 'killed', extra = {}) =>
  enqueueWorkflowNotification({ taskId: task.id, setAppState, status, summary: task.summary,
    agentCount: 1, totalTokens: 10, totalToolCalls: 2, durationMs: 30, ...extra })

function owner() {
  const id = generateTaskId('local_agent')
  const task: LocalAgentTaskState = { ...createTaskStateBase(id, 'local_agent', 'Owner'),
    type: 'local_agent', status: 'running', agentId: id, prompt: 'Own workflow', agentType: 'general-purpose',
    retrieved: false, lastReportedToolCount: 0, lastReportedTokenCount: 0,
    isBackgrounded: true, pendingMessages: [], retain: false, diskLoaded: false }
  registerTask(task, setAppState)
  return task
}

describe('workflow ownership leases', () => {
  test('completed owner stays alive until its queued child result is consumed, then grace starts once', async () => {
    setIsInteractive(true)
    const parent = owner(), task = await start(parent.id), reason = `workflow:${task.id}`
    assert.equal((state.tasks[parent.id] as LocalAgentTaskState).keepaliveReasons?.has(reason), true)
    completeAgentTask({ agentId: parent.id } as never, setAppState)
    assert.equal(isLocalAgentKeptAlive(state.tasks[parent.id]), true)
    assert.equal((state.tasks[parent.id] as LocalAgentTaskState).evictAfter, undefined)
    updateTaskState(parent.id, setAppState, t => ({ ...t, notified: true }))
    evictTerminalTask(parent.id, setAppState)
    assert.ok(state.tasks[parent.id])
    completeWorkflowTask(task.id, 42, 1, [], setAppState)
    notice(task, 'completed', { result: 42 })
    assert.equal(getCommandQueue().at(-1)!.agentId, parent.id)
    assert.equal(getCommandQueue().at(-1)!.taskId, task.id)
    reconcileWorkflowOwnerLeases(parent.id, new Set(getCommandQueue().map(c => c.taskId!).filter(Boolean)), setAppState)
    assert.equal(isLocalAgentKeptAlive(state.tasks[parent.id]), true)
    clearCommandQueue()
    reconcileWorkflowOwnerLeases(parent.id, new Set(), setAppState)
    const settled = state.tasks[parent.id] as LocalAgentTaskState
    assert.equal(isLocalAgentKeptAlive(settled), false)
    assert.ok(settled.evictAfter! > Date.now())
    assert.equal(releaseLocalAgentKeepalive(parent.id, reason, setAppState), false)
    reconcileWorkflowOwnerLeases(parent.id, new Set(), setAppState)
    assert.equal(state.tasks[parent.id], settled)
  })

  test('running owners receive results; failed, removed and headless completed owners fall back to root', async () => {
    for (const status of ['running', 'failed', 'removed', 'headless-completed'] as const) {
      setIsInteractive(true)
      const parent = owner(), task = await start(parent.id)
      if (status === 'removed') delete state.tasks[parent.id]
      else if (status !== 'running') updateTaskState<LocalAgentTaskState>(parent.id, setAppState, t => ({ ...t, status: status === 'failed' ? 'failed' : 'completed' }))
      if (status === 'headless-completed') setIsInteractive(false)
      completeWorkflowTask(task.id, 42, 1, [], setAppState)
      notice(task, 'completed', { result: 42 })
      assert.equal(getCommandQueue().at(-1)!.agentId, status === 'running' ? parent.id : undefined)
      if (status !== 'removed') assert.equal((state.tasks[parent.id] as LocalAgentTaskState).keepaliveReasons?.size, status === 'running' ? 1 : 0)
      clearCommandQueue()
      reconcileWorkflowOwnerLeases(parent.id, new Set(), setAppState)
    }
  })

  test('pause, kill, suppressed completion and failure release only their own lease exactly once', async () => {
    setIsInteractive(true)
    for (const outcome of ['paused', 'killed', 'completed', 'failed'] as const) {
      const parent = owner(), task = await start(parent.id)
      acquireLocalAgentKeepalive(parent.id, 'agent:other-child', setAppState)
      if (outcome === 'paused') { assert.equal(pauseWorkflowTask(task.id, setAppState), true); assert.equal(pauseWorkflowTask(task.id, setAppState), false) }
      else if (outcome === 'killed') { assert.equal(killWorkflowTask(task.id, setAppState), true); assert.equal(killWorkflowTask(task.id, setAppState), false) }
      else {
        if (outcome === 'completed') completeWorkflowTask(task.id, 42, 1, [], setAppState)
        else failWorkflowTask(task.id, 'failed', 1, [], setAppState)
        assert.equal(notice(task, outcome, { suppressCompletionNotification: true }), true)
        assert.equal(notice(task, outcome, { suppressCompletionNotification: true }), false)
      }
      assert.deepEqual([...(state.tasks[parent.id] as LocalAgentTaskState).keepaliveReasons!], ['agent:other-child'])
      assert.equal(releaseLocalAgentKeepalive(parent.id, `workflow:${task.id}`, setAppState), false)
    }
  })

  test('owner replacement preserves leases; reconciliation never drops still-running child work', async () => {
    setIsInteractive(true)
    const parent = owner(), task = await start(parent.id)
    const before = state.tasks[parent.id] as LocalAgentTaskState
    registerTask({ ...parent, description: 'Resumed owner' }, setAppState)
    assert.equal((state.tasks[parent.id] as LocalAgentTaskState).keepaliveReasons, before.keepaliveReasons)
    reconcileWorkflowOwnerLeases(parent.id, new Set(), setAppState)
    assert.equal((state.tasks[parent.id] as LocalAgentTaskState).keepaliveReasons?.has(`workflow:${task.id}`), true)
    assert.equal(acquireLocalAgentKeepalive(parent.id, `workflow:${task.id}`, setAppState), false)
    assert.equal(acquireLocalAgentKeepalive(task.id, 'wrong-type', setAppState), false)
    assert.equal(releaseLocalAgentKeepalive('absent', 'missing', setAppState), false)
  })
})

test('registration is execution-owned; duplicate adoption cannot replace a running task', async () => {
  const task = await start()
  assert.deepEqual(drainSdkEvents().map(e => e.subtype), ['task_started'])
  assert.throws(() => registerAdoptedWorkflowTask({ taskId: task.id, description: 'late', workflowRunId: task.workflowRunId }, setAppState), /already registered/)
  assert.equal(current(task), task)
  assert.equal(drainSdkEvents().length, 0)
})

test('progress upserts each phase and agent; totals do not double count retries or batches', async () => {
  const task = await start()
  updateWorkflowProgressBatch(task.id, [
    { type: 'workflow_phase', index: 1, title: 'Review' },
    { type: 'workflow_agent', index: 1, label: 'A', state: 'start', tokens: 2 },
    { type: 'workflow_agent', index: 1, label: 'A', state: 'progress', tokens: 8, toolCalls: 2 },
    { type: 'workflow_agent', index: 2, label: 'B', state: 'start', tokens: 4, toolCalls: 1 },
  ], setAppState)
  assert.equal(current(task).workflowProgress.length, 3)
  assert.equal(current(task).progressVersion, 4)
  assert.equal(current(task).agentCount, 2)
  assert.equal(current(task).totalTokens, 12)
  assert.equal(current(task).totalToolCalls, 3)
  updateWorkflowProgressBatch(task.id, Array.from({ length: 1200 }, (_, i) => ({ type: 'workflow_log', message: String(i) })), setAppState)
  assert.equal(current(task).workflowProgress.length, 500)
  assert.equal(current(task).workflowProgress.filter(p => p.type !== 'workflow_log').length, 3)
  assert.equal(current(task).totalTokens, 12)
  killWorkflowTask(task.id, setAppState)
  const terminal = current(task)
  updateWorkflowProgressBatch(task.id, [{ type: 'workflow_agent', index: 1, label: 'late', state: 'done', tokens: 999 }], setAppState)
  assert.equal(current(task), terminal)
})

test('terminal publication precedes abort callbacks; kill/fail/complete race closes exactly once', async () => {
  const task = await start(), child = new AbortController()
  task.agentControllers!.set('child', child)
  let callbacks = 0
  task.abortController!.signal.addEventListener('abort', () => {
    callbacks++
    assert.equal(failWorkflowTask(task.id, 'late error', 0, [], setAppState), false)
    assert.equal(completeWorkflowTask(task.id, 'late result', 0, [], setAppState), false)
  })
  assert.equal(killWorkflowTask(task.id, setAppState), true)
  assert.equal(killWorkflowTask(task.id, setAppState), false)
  assert.equal(current(task).status, 'killed')
  assert.equal(callbacks, 1)
  assert.equal(child.signal.aborted, true)
  assert.equal(current(task).agentControllers, undefined)
  assert.equal(notice(task, 'killed'), false)
  assert.deepEqual(drainSdkEvents().map(e => e.subtype), ['task_started', 'task_notification'])
  assert.equal(getCommandQueue().length, 0)
})

test('skip and retry affect only the selected child; original reasons reach runner', async () => {
  const task = await start(), first = new AbortController(), second = new AbortController()
  task.agentControllers!.set('first', first); task.agentControllers!.set('second', second)
  assert.equal(skipWorkflowAgent(task.id, 'missing', setAppState), false)
  assert.equal(skipWorkflowAgent(task.id, 'first', setAppState), true)
  assert.equal(first.signal.reason.name, 'AbortError')
  assert.equal(first.signal.reason.message, 'user-skip')
  assert.equal(retryWorkflowAgent(task.id, 'first', setAppState), false)
  assert.equal(second.signal.aborted, false)
  assert.equal(task.abortController!.signal.aborted, false)
  assert.equal(retryWorkflowAgent(task.id, 'second', setAppState), true)
  assert.equal(second.signal.reason.message, 'user-retry')
  assert.equal(current(task).status, 'running')
})

test('completion persists falsy results; XML delivery is claimed exactly once and safely escaped', async () => {
  for (const result of [false, 0, '', null, [], {}]) {
    const task = await start()
    assert.equal(completeWorkflowTask(task.id, result, 1, ['log'], setAppState), true)
    assert.equal(completeWorkflowTask(task.id, 99, 1, [], setAppState), false)
    await Promise.resolve(); await flushTaskOutput(task.id)
    assert.deepEqual(JSON.parse(await readFile(task.outputFile, 'utf8')).result, result)
    assert.equal(notice(task, 'completed', { result, summary: '<bad&>', failures: ['</failures><status>failed</status>'] }), true)
    assert.equal(notice(task, 'completed', { result }), false)
    const queued = getCommandQueue().at(-1)!
    assert.equal(queued.mode, 'task-notification')
    assert.equal(queued.taskId, task.id)
    assert.match(String(queued.value), /&lt;bad&amp;&gt;/)
    assert.match(String(queued.value), /<status>completed<\/status>/)
    assert.equal(String(queued.value).includes('<status>failed</status>'), false)
  }
  // XML delivery is translated by print.ts. No direct SDK duplicate is queued.
  assert.equal(drainSdkEvents().filter(e => e.subtype === 'task_notification').length, 0)
  assert.equal(getCommandQueue().length, 6)
})

test('suppressed completion and TaskOutput-first race retain one SDK closing bookend', async () => {
  const suppressed = await start()
  completeWorkflowTask(suppressed.id, 42, 1, [], setAppState)
  assert.equal(notice(suppressed, 'completed', { suppressCompletionNotification: true }), true)
  assert.equal(notice(suppressed, 'completed', { suppressCompletionNotification: true }), false)
  const readFirst = await start()
  failWorkflowTask(readFirst.id, 'failure', 0, [], setAppState)
  updateTaskState(readFirst.id, setAppState, t => ({ ...t, notified: true }))
  assert.equal(notice(readFirst, 'failed', { error: 'failure' }), true)
  assert.equal(notice(readFirst, 'failed', { error: 'failure' }), false)
  assert.equal(getCommandQueue().length, 0)
  assert.deepEqual(drainSdkEvents().filter(e => e.subtype === 'task_notification').map(e => 'status' in e && e.status), ['completed', 'failed'])
})

describe('paused workflow compatibility with the existing task framework', () => {
  test('both eviction paths preserve the terminal result for its panel grace period', async () => {
    const task = await start()
    completeWorkflowTask(task.id, 42, 1, [], setAppState)
    notice(task, 'completed', { result: 42 })
    evictTerminalTask(task.id, setAppState)
    assert.equal(current(task).status, 'completed')
    const attachments = await generateTaskAttachments(state)
    assert.deepEqual(attachments.evictedTaskIds, [task.id])
    applyTaskOffsetsAndEvictions(setAppState, {}, attachments.evictedTaskIds)
    assert.equal(current(task).status, 'completed')
    updateTaskState<LocalWorkflowTaskState>(task.id, setAppState, t => ({ ...t, evictAfter: Date.now() - 1 }))
    applyTaskOffsetsAndEvictions(setAppState, {}, [task.id])
    assert.equal(current(task), undefined)
  })

  test('pause halts all children but neither completes nor evicts task', async () => {
    const task = await start(), child = new AbortController()
    task.agentControllers!.set('child', child)
    assert.equal(pauseWorkflowTask(task.id, setAppState), true)
    assert.equal(pauseWorkflowTask(task.id, setAppState), false)
    assert.equal(child.signal.aborted, true)
    assert.equal(current(task).status, 'paused')
    assert.equal(isTerminalTaskStatus(current(task).status), false)
    assert.equal(isBackgroundTask(current(task)), true)
    evictTerminalTask(task.id, setAppState)
    const attachments = await generateTaskAttachments(state)
    assert.deepEqual(attachments.evictedTaskIds, [])
    applyTaskOffsetsAndEvictions(setAppState, {}, [task.id])
    assert.equal(current(task).status, 'paused')
    assert.equal(drainSdkEvents().filter(e => e.subtype === 'task_notification').length, 0)
    assert.equal(failWorkflowTask(task.id, 'late abort', 0, [], setAppState), false)
  })

  test('adopted task stays paused when TaskOutput polls; blocking read times out without notification', async () => {
    const task = registerAdoptedWorkflowTask({ taskId: generateTaskId('local_workflow'),
      description: 'Adopted', workflowRunId: 'wf_adopted', startTime: 123 }, setAppState)
    const context = { getAppState: () => state, setAppState, abortController: new AbortController() }
    const nonblocking = await TaskOutputTool.call({ task_id: task.id, block: false, timeout: 0 }, context as never, undefined as never, undefined as never)
    assert.equal(nonblocking.data.retrieval_status, 'not_ready')
    assert.equal(nonblocking.data.task?.status, 'paused')
    const blocking = await TaskOutputTool.call({ task_id: task.id, block: true, timeout: 1 }, context as never, undefined as never, undefined as never)
    assert.equal(blocking.data.retrieval_status, 'timeout')
    assert.equal(current(task).startTime, 123)
    assert.equal(current(task).status, 'paused')
    assert.equal(drainSdkEvents().filter(e => e.subtype === 'task_notification').length, 0)
  })
})

test('progress batch flush/cancel preserve ordering and prevent a late pending batch after termination', async () => {
  const delivered: WorkflowProgress[][] = [], sdk: WorkflowProgress[][] = []
  const batcher = createWorkflowProgressBatcher({ onBatch: b => delivered.push(b), onSdkEmit: b => sdk.push(b) })
  batcher.onProgress({ type: 'workflow_log', message: 'first' })
  batcher.onProgress({ type: 'workflow_phase', index: 1, title: 'second' })
  batcher.flushNow()
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]!.length, 2)
  assert.equal(sdk.length, 1)
  batcher.onProgress({ type: 'workflow_log', message: 'discard' })
  batcher.cancel()
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(delivered.length, 1)
  batcher.flushNow()
  assert.equal(delivered.length, 1)
})

test('TUI foreground batches do not enqueue SDK progress; hidden TUI throttles with forced final flush', async () => {
  const batches: WorkflowProgress[][] = [], sdk: WorkflowProgress[][] = []
  let background = false
  const batcher = createWorkflowProgressBatcher({ onBatch: b => batches.push(b), onSdkEmit: b => sdk.push(b),
    isNonInteractive: () => false, isBackground: () => background })
  batcher.onProgress({ type: 'workflow_log', message: 'foreground' }); batcher.flushNow()
  assert.equal(sdk.length, 0)
  background = true
  batcher.onProgress({ type: 'workflow_log', message: 'hidden1' })
  await new Promise(resolve => setTimeout(resolve, 25))
  batcher.onProgress({ type: 'workflow_log', message: 'hidden2' })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(sdk.length, 1)
  batcher.flushNow()
  assert.equal(sdk.length, 2)
  batcher.cancel()
})
