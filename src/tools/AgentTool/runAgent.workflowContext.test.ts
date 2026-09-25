import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import type { QueryParams } from '../../query.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { getAgentContext, runWithAgentContext, type SubagentContext } from '../../utils/agentContext.js'

const queryModule = await import('../../query.js')
const storage = await import('../../utils/sessionStorage.js')
const hooks = await import('../../utils/hooks.js')
const settings = await import('../../utils/settings/settings.js')
const frozen = await import('../../utils/model/darbFrozenContext.js')
let settingsFixture: Partial<SettingsJson> = {}
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
mock.module('../../utils/settings/settings.js', () => ({
  ...settings, getInitialSettings: () => settingsFixture, getSettings_DEPRECATED: () => settingsFixture,
}))
const { runAgent } = await import('./runAgent.js')
beforeEach(() => { settingsFixture = {}; calls.length = 0 })
afterAll(() => { settingsFixture = {}; mock.restore() })

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

async function execute(required?: boolean, model = 'inherit', onModelRestricted?: (requested: string, resolved: string) => void) {
  const context = parentContext()
  const identity: SubagentContext = {
    agentId: 'workflow-child', agentType: 'subagent', parentAgentId: 'parent',
    workflowRunId: 'wf-test', workflowName: 'change', depth: 1,
    isAsync: false, isBackgroundAgent: true,
  }
  const result = await runWithAgentContext(identity, async () => {
    const received = []
    for await (const message of runAgent({
      agentDefinition: { agentType: 'general-purpose', model, source: 'built-in' } as never,
      promptMessages: [], toolUseContext: context,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAsync: false, querySource: 'agent:builtin:general-purpose',
      availableTools: [], useExactTools: true,
      requiresStructuredOutput: required, spawnedByWorkflowRunId: 'wf-test',
      spawnedBySkill: 'product-intent', spawnedByForkedSkill: true,
      onModelRestricted,
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

test('restriction callback reports the model actually passed into query', async () => {
  settingsFixture.availableModels = ['sonnet']
  const changed = mock(() => {})
  const { call } = await execute(false, 'opus', changed)
  expect(changed.mock.calls).toEqual([['opus', call.params.toolUseContext.options.mainLoopModel]])
  expect(call.params.toolUseContext.options.mainLoopModel).toBe('claude-sonnet-4-6')
})

function configureRoute(allow: string[]) {
  settingsFixture = {
    availableModels: allow,
    agentRouting: { default: 'Vendor/Route-ID' },
    agentModels: { 'Vendor/Route-ID': { base_url: 'https://route.example.test/v1', api_key: 'fixture-key' } },
  }
}

test('a permitted provider route retains its exact binding without a fictitious fallback callback', async () => {
  configureRoute(['Vendor/Route-ID'])
  const changed = mock(() => {})
  const { call } = await execute(false, 'opus', changed)
  expect(changed).not.toHaveBeenCalled()
  expect(call.params.toolUseContext.options.mainLoopModel).toBe('Vendor/Route-ID')
  expect(call.params.toolUseContext.options.providerOverride).toEqual({
    model: 'Vendor/Route-ID', baseURL: 'https://route.example.test/v1', apiKey: 'fixture-key',
  })
})

test('a forbidden provider route cannot bypass restrictions or reach query', async () => {
  configureRoute(['sonnet'])
  await expect(execute()).rejects.toThrow('route model')
  expect(calls).toEqual([])
})

test('provider routing cannot replace a frozen Darb connection even with an allowed ID', async () => {
  configureRoute(['Vendor/Route-ID'])
  const lookup = spyOn(frozen, 'getDarbFrozenModelContext').mockImplementation(() => ({ model: 'Vendor/Route-ID' }) as never)
  try {
    await expect(execute()).rejects.toThrow('cannot override the selected Darb model and connection')
    expect(calls).toEqual([])
  } finally { lookup.mockRestore() }
})
