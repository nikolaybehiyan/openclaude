import { afterAll, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import type { QueryParams } from '../../query.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { getAgentContext, runWithAgentContext, type SubagentContext } from '../../utils/agentContext.js'

const queryModule = await import('../../query.js')
const storage = await import('../../utils/sessionStorage.js')
const hooks = await import('../../utils/hooks.js')
const settings = await import('../../utils/settings/settings.js')
const calls: { params: QueryParams; identity: ReturnType<typeof getAgentContext> }[] = []
const output = { type: 'attachment', attachment: { type: 'structured_output', data: { approved: true } } }
mock.module('../../query.js', () => ({
  ...queryModule,
  query: async function* (params: QueryParams) {
    await Promise.resolve()
    calls.push({ params, identity: getAgentContext() })
    yield output
  },
}))
mock.module('../../utils/sessionStorage.js', () => ({
  ...storage,
  recordSidechainTranscript: async () => {},
  writeAgentMetadata: async () => {},
}))
mock.module('../../utils/hooks.js', () => ({
  ...hooks,
  executeSubagentStartHooks: async function* () {},
}))
mock.module('../../utils/settings/settings.js', () => ({ ...settings, getInitialSettings: () => ({}) }))
const { runAgent } = await import('./runAgent.js')
afterAll(() => mock.restore())

function parentContext(): ToolUseContext {
  let state = { toolPermissionContext: getEmptyToolPermissionContext(), todos: {}, tasks: {} }
  return {
    options: {
      mainLoopModel: 'claude-sonnet-4-6', tools: [], commands: [],
      thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
      agentDefinitions: { activeAgents: [] }, requiresStructuredOutput: true,
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => state,
    setAppState: update => { state = update(state as never) as unknown as typeof state },
    messages: [],
  } as unknown as ToolUseContext
}

async function execute(required?: boolean) {
  const context = parentContext()
  const identity: SubagentContext = {
    agentId: 'workflow-child', agentType: 'subagent', parentAgentId: 'parent',
    workflowRunId: 'wf-test', workflowName: 'change', depth: 1,
    isAsync: false, isBackgroundAgent: true,
  }
  const result = await runWithAgentContext(identity, async () => {
    const received = []
    for await (const message of runAgent({
      agentDefinition: { agentType: 'general-purpose', model: 'inherit', source: 'built-in' } as never,
      promptMessages: [], toolUseContext: context,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAsync: false, querySource: 'agent:builtin:general-purpose',
      availableTools: [], useExactTools: true,
      requiresStructuredOutput: required, spawnedByWorkflowRunId: 'wf-test',
      spawnedBySkill: 'product-intent', spawnedByForkedSkill: true,
      override: {
        agentId: 'workflow-child' as never, agentContext: identity,
        userContext: {}, systemContext: {}, systemPrompt: [],
      },
    })) received.push(message)
    return received
  })
  return { context, identity, result, call: calls.at(-1)! }
}

test('runAgent carries Workflow identity and schema requirement into the actual query', async () => {
  const { context, identity, result, call } = await execute(true)
  expect(call.params.toolUseContext.agentContext).toBe(identity)
  expect(call.identity).toBe(identity)
  expect(call.params.toolUseContext.spawnedByWorkflowRunId).toBe('wf-test')
  expect(call.params.toolUseContext.options.requiresStructuredOutput).toBe(true)
  expect(call.params.toolUseContext.options.spawnedBySkill).toBe('product-intent')
  expect(call.params.toolUseContext.options.spawnedByForkedSkill).toBe(true)
  expect(call.params.toolUseContext.options.mainLoopModel).toBe(context.options.mainLoopModel)
  expect(result).toEqual([output])
  expect(context.agentContext).toBeUndefined()
})

test('an ordinary child does not inherit the parent schema requirement implicitly', async () => {
  const { context, call } = await execute()
  expect(context.options.requiresStructuredOutput).toBe(true)
  expect(call.params.toolUseContext.options.requiresStructuredOutput).toBeUndefined()
})
