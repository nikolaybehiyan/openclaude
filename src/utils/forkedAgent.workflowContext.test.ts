import { expect, test } from 'bun:test'
import type { ToolUseContext } from '../Tool.js'
import { getAgentContext, runWithAgentContext, type SubagentContext } from './agentContext.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import { createSubagentContext } from './forkedAgent.js'

function context(lineage: SubagentContext): ToolUseContext {
  return {
    options: {},
    agentContext: lineage,
    spawnedByWorkflowRunId: lineage.workflowRunId,
    isBackgroundAgent: true,
    readFileState: createFileStateCacheWithSizeLimit(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    setAppState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}
const lineage = (id: string, workflow: string): SubagentContext => ({
  agentId: id, agentType: 'subagent', parentAgentId: 'parent', depth: 2,
  workflowRunId: workflow, workflowName: 'bank-change', isAsync: false,
  isBackgroundAgent: true,
})

test('nested subagents preserve workflow lineage and background status', () => {
  const identity = lineage('a', 'workflow-a')
  const parent = context(identity)
  const child = createSubagentContext(parent)
  const grandchild = createSubagentContext(child, { isBackgroundAgent: false })
  expect(child.agentContext).toBe(identity)
  expect(grandchild.agentContext).toBe(identity)
  expect(grandchild.spawnedByWorkflowRunId).toBe('workflow-a')
  expect(grandchild.isBackgroundAgent).toBe(true)
  expect(child.readFileState).not.toBe(parent.readFileState)
  child.abortController.abort()
  expect(parent.abortController.signal.aborted).toBe(false)
})

test('explicit Workflow identity overrides parent without mutating it', () => {
  const parent = context(lineage('a', 'workflow-a'))
  const identity = lineage('b', 'workflow-b')
  const child = createSubagentContext(parent, {
    agentContext: identity, spawnedByWorkflowRunId: 'workflow-b',
  })
  expect(child.agentContext).toBe(identity)
  expect(child.spawnedByWorkflowRunId).toBe('workflow-b')
  expect(parent.spawnedByWorkflowRunId).toBe('workflow-a')
  expect(parent.agentContext?.agentId).toBe('a')
})

test('concurrent generator consumption retains separate workflow attribution', async () => {
  async function* work() {
    await Promise.resolve()
    yield getAgentContext()
    await Promise.resolve()
    yield getAgentContext()
  }
  const a = lineage('a', 'workflow-a'), b = lineage('b', 'workflow-b')
  const consume = (identity: SubagentContext) => runWithAgentContext(identity, async () => {
    const seen = []
    for await (const current of work()) seen.push(current)
    return seen
  })
  expect(await Promise.all([consume(a), consume(b)])).toEqual([[a, a], [b, b]])
  expect(getAgentContext()).toBeUndefined()
})
