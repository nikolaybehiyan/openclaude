import { afterAll, afterEach, beforeEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCwdState, setIsInteractive } from '../bootstrap/state.js'
import { createTaskStateBase, generateTaskId, type SetAppState } from '../Task.js'
import type { AppState } from '../state/AppState.js'
import { asAgentId } from '../types/ids.js'
import { completeAgentTask, forLocalAgentExecution, isLocalAgentKeptAlive, killAsyncAgent, type LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { buildResumePrompt, completeWorkflowTask, enqueueWorkflowNotification, registerWorkflowTask } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { AgentResumeStateError, reserveAgentResume } from '../tools/AgentTool/resumeOwnership.js'
import { runAsyncAgentLifecycle } from '../tools/AgentTool/agentToolUtils.js'
import { createAssistantMessage } from './messages.js'
import { clearCommandQueue, enqueuePendingNotification, getCommandQueue, remove } from './messageQueueManager.js'
import { registerTask } from './task/framework.js'
import { _clearOutputsForTest, _resetTaskOutputDirForTest, getTaskOutputDir } from './task/diskOutput.js'
import { createWorkflowOwnerWakeRouter, reconcileConsumedWorkflowNotifications, type WorkflowOwnerWakeRequest } from './workflowOwnerWake.js'

const root = await mkdtemp(join(tmpdir(), 'darb-workflow-wake-test-'))
setCwdState(root); _resetTaskOutputDirForTest()
const outputDir = getTaskOutputDir()
let state: AppState
const setAppState: SetAppState = update => { state = update(state) }
const context = { getAppState: () => state, setAppState }
const routers: ReturnType<typeof createWorkflowOwnerWakeRouter>[] = []
beforeEach(() => { state = { tasks: {} } as AppState; setIsInteractive(true); clearCommandQueue() })
afterEach(async () => { for (const router of routers.splice(0)) router.dispose(); clearCommandQueue(); await _clearOutputsForTest() })
afterAll(async () => { await rm(root, { recursive: true, force: true }); await rm(outputDir, { recursive: true, force: true }) })

function owner() {
  const id = generateTaskId('local_agent')
  const task: LocalAgentTaskState = { ...createTaskStateBase(id, 'local_agent', 'Owner'),
    type: 'local_agent', status: 'running', executionId: randomUUID(), agentId: id,
    prompt: 'Own work', agentType: 'general-purpose', abortController: new AbortController(),
    retrieved: false, lastReportedToolCount: 0, lastReportedTokenCount: 0, isBackgrounded: true,
    pendingMessages: [], retain: false, diskLoaded: false }
  registerTask(task, setAppState)
  return task
}
async function child(parent: LocalAgentTaskState) {
  const task = registerWorkflowTask({ taskId: generateTaskId('local_workflow'), script: 'return 42',
    workflowRunId: 'wf_test', ownerAgentId: asAgentId(parent.id), setAppState })
  await task.outputReady
  completeWorkflowTask(task.id, 42, 1, [], setAppState)
  enqueueWorkflowNotification({ taskId: task.id, setAppState, status: 'completed', result: 42,
    agentCount: 1, totalTokens: 10, totalToolCalls: 0, durationMs: 5 })
  return task
}
function finishOwner(parent: LocalAgentTaskState) { completeAgentTask({ agentId: parent.id } as never, setAppState) }
function router(resume: (request: WorkflowOwnerWakeRequest) => Promise<unknown>, errors: unknown[] = []) {
  const result = createWorkflowOwnerWakeRouter({ ...context, resume, onError: error => errors.push(error), retryDelayMs: 1000 })
  routers.push(result); return result
}

test('idle wake commits exact queued batch once; newer notification stays for the running query', async () => {
  const parent = owner(), first = await child(parent)
  finishOwner(parent)
  const pending = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  let calls = 0
  const wake = router(async request => {
    calls++; started.resolve()
    await pending.promise
    const reservation = reserveAgentResume({ agentId: parent.id, ...context, expectedTask: request.expectedTask })
    try {
      reservation.assertEligible()
      registerTask({ ...parent, executionId: randomUUID() }, setAppState)
      request.onDeliveryCommitted(); request.onDeliveryCommitted()
    } finally { reservation.release() }
  })
  const run = wake.flush()
  await started.promise
  await wake.flush()
  const second = await child(parent)
  pending.resolve(); await run
  assert.equal(calls, 1)
  assert.deepEqual(getCommandQueue().map(c => c.taskId), [second.id])
  const leased = state.tasks[parent.id] as LocalAgentTaskState
  assert.equal(leased.keepaliveReasons?.has(`workflow:${first.id}`), false)
  assert.equal(leased.keepaliveReasons?.has(`workflow:${second.id}`), true)
  const consumed = getCommandQueue()
  remove(consumed); reconcileConsumedWorkflowNotifications(consumed, context)
  assert.equal((state.tasks[parent.id] as LocalAgentTaskState).keepaliveReasons?.size, 0)
})

test('setup failure retains queue and lease without a tight retry loop', async () => {
  const parent = owner(), task = await child(parent); finishOwner(parent)
  const errors: unknown[] = []; let calls = 0
  const wake = router(async () => { calls++; throw new Error('transcript unavailable') }, errors)
  await wake.flush(); await wake.flush()
  assert.equal(calls, 1); assert.equal(errors.length, 1)
  assert.deepEqual(getCommandQueue().map(c => c.taskId), [task.id])
  assert.equal(isLocalAgentKeptAlive(state.tasks[parent.id]), true)
})

test('wake and SendMessage cannot reserve the same owner; a stop during setup cannot resurrect it', async () => {
  const parent = owner(); await child(parent); finishOwner(parent)
  const expectedTask = state.tasks[parent.id] as LocalAgentTaskState
  const reservation = reserveAgentResume({ agentId: parent.id, ...context, expectedTask })
  assert.throws(() => reserveAgentResume({ agentId: parent.id, ...context }), AgentResumeStateError)
  killAsyncAgent(parent.id, setAppState)
  assert.throws(reservation.assertEligible, AgentResumeStateError)
  reservation.release()
  assert.equal(state.tasks[parent.id]!.status, 'killed')
  assert.equal((state.tasks[parent.id] as LocalAgentTaskState).resuming, undefined)
  assert.equal((state.tasks[parent.id] as LocalAgentTaskState).keepaliveReasons?.size, 0)
  assert.equal(getCommandQueue()[0]!.agentId, undefined)
  assert.throws(() => reserveAgentResume({ agentId: parent.id, ...context, expectedTask }), AgentResumeStateError)
})

test('explicit resume clears a failed wake retry while the running query owns delivery', async () => {
  const parent = owner(); await child(parent); finishOwner(parent)
  let calls = 0
  const wake = router(async () => { calls++; throw new Error('setup unavailable') })
  await wake.flush()
  registerTask({ ...parent, executionId: randomUUID() }, setAppState)
  await wake.flush()
  // The queued child result belongs to the new running query, not an automatic
  // retry of the already-failed idle-owner dispatch.
  assert.equal(calls, 1)
  assert.equal(getCommandQueue().length, 1)
  assert.equal(state.tasks[parent.id]!.status, 'running')
})

test('removed owner notification is rerouted to root; user input is never delivered to an idle owner', async () => {
  const parent = owner(), task = await child(parent)
  delete state.tasks[parent.id]
  enqueuePendingNotification({ mode: 'prompt', value: 'Human prompt', agentId: asAgentId(parent.id) })
  let calls = 0
  await router(async () => { calls++ }).flush()
  assert.equal(calls, 0)
  assert.equal(getCommandQueue().find(c => c.taskId === task.id)!.agentId, undefined)
  assert.equal(getCommandQueue().find(c => c.mode === 'prompt')!.agentId, parent.id)
})

test('execution guard rejects an old completion callback after the same agent is resumed', () => {
  const old = owner(), oldSet = forLocalAgentExecution(old.id, old.executionId, setAppState)
  const fresh = { ...old, executionId: randomUUID(), description: 'New generation' }
  registerTask(fresh, setAppState)
  completeAgentTask({ agentId: old.id } as never, oldSet)
  assert.equal(state.tasks[old.id]!.status, 'running')
  assert.equal(state.tasks[old.id]!.notified, false)
})

test('actual async lifecycle cannot notify over a replacement run while awaiting final metadata', async () => {
  const old = owner(), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<{}>()
  const run = runAsyncAgentLifecycle({ taskId: old.id, abortController: old.abortController!,
    makeStream: async function* () { yield createAssistantMessage({ content: 'Old result' }) },
    metadata: { prompt: 'test', resolvedAgentModel: 'test', isBuiltInAgent: true, startTime: Date.now(), agentType: 'general-purpose', isAsync: true },
    description: 'Old run', toolUseContext: { getAppState: () => state, options: { tools: [] } } as never,
    rootSetAppState: setAppState, agentIdForCleanup: old.id, enableSummarization: false,
    getWorktreeResult: () => { entered.resolve(); return finish.promise },
  })
  await entered.promise
  assert.equal(state.tasks[old.id]!.status, 'completed')
  registerTask({ ...old, executionId: randomUUID(), notified: false, description: 'New run' }, setAppState)
  finish.resolve({}); await run
  assert.equal(state.tasks[old.id]!.status, 'running')
  assert.equal(state.tasks[old.id]!.notified, false)
  assert.equal(getCommandQueue().length, 0)
})

test('resume prompt preserves quoted paths, backslashes, run IDs and arguments', () => {
  const task = { scriptPath: "/home/claude/it's \\ a workflow.js", workflowRunId: "wf_'quoted", args: { phrase: "it's done" } }
  const prompt = buildResumePrompt(task)
  assert.ok(prompt.includes(`scriptPath: ${JSON.stringify(task.scriptPath)}`))
  assert.ok(prompt.includes(`resumeFromRunId: ${JSON.stringify(task.workflowRunId)}`))
  assert.ok(prompt.includes(`args: ${JSON.stringify(task.args)}`))
})
