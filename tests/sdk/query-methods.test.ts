import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { query } from '../../src/entrypoints/sdk/index.js'

// These tests don't iterate — they test QueryImpl methods that manipulate
// internal state. Auth stub needed because query() triggers init() path.
const AUTH_KEY = 'ANTHROPIC_API_KEY'
let savedApiKey: string | undefined

beforeAll(() => {
  savedApiKey = process.env[AUTH_KEY]
  if (!savedApiKey) process.env[AUTH_KEY] = 'sk-test-query-methods-stub'
})

afterAll(() => {
  if (savedApiKey === undefined) delete process.env[AUTH_KEY]
  else process.env[AUTH_KEY] = savedApiKey
})

describe('QueryImpl multipart system prompt', () => {
  test('Cowork execution options survive permission mode changes', async () => {
    const toolAliases = { Bash: 'mcp__device__shell' }
    const q = query({ prompt: 'test', options: {
      cwd: process.cwd(), appendSubagentSystemPrompt: 'DEVICE_BOUNDARY', toolAliases, planModeInstructions: 'COWORK_PLAN',
    } })
    try {
      expect((q as any)._engine.config.appendSubagentSystemPrompt).toBe('DEVICE_BOUNDARY')
      expect((q as any)._engine.config.planModeInstructions).toBe('COWORK_PLAN')
      expect((q as any)._engine.config.toolAliases).toEqual(toolAliases)
      for (const mode of ['plan', 'default'] as const) {
        await q.setPermissionMode(mode)
        expect((q as any).appStateStore.getState().toolPermissionContext.toolAliases).toEqual(toolAliases)
      }
    } finally { q.interrupt() }
  })
  for (const sections of [[], ['COWORK_BASE', 'CACHE_BOUNDARY', 'DEVICE_CONTEXT']]) {
    test(`query preserves ${sections.length} custom sections`, () => {
      const q = query({ prompt: 'test', options: { cwd: process.cwd(), systemPrompt: sections } })
      expect((q as any)._engine.config.customSystemPrompt).toEqual(sections)
      q.interrupt()
    })
  }
})

describe('QueryImpl.setModel', () => {
  test('updates model in app state', async () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    await q.setModel('claude-haiku-4-5')

    const state = (q as any).appStateStore.getState()
    expect(state.mainLoopModel).toBe('claude-haiku-4-5')
    expect(state.mainLoopModelForSession).toBe('claude-haiku-4-5')
    q.interrupt()
  })
})

describe('QueryImpl.supportedAgents', () => {
  test('returns agentType list from active agents', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    // Simulate agents loaded into app state
    ;(q as any).appStateStore.setState(() => ({
      ...(q as any).appStateStore.getState(),
      agentDefinitions: {
        activeAgents: [
          { agentType: 'code-reviewer' },
          { agentType: 'test-runner' },
        ],
      },
    }))

    const agents = q.supportedAgents()
    expect(agents).toEqual(['code-reviewer', 'test-runner'])
    q.interrupt()
  })

  test('returns empty array when no agents loaded', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    const agents = q.supportedAgents()
    expect(agents).toEqual([])
    q.interrupt()
  })

  test('filters out entries with falsy agentType', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    ;(q as any).appStateStore.setState(() => ({
      ...(q as any).appStateStore.getState(),
      agentDefinitions: {
        activeAgents: [
          { agentType: 'valid-agent' },
          { agentType: null },
          { agentType: '' },
        ],
      },
    }))

    const agents = q.supportedAgents()
    expect(agents).toEqual(['valid-agent'])
    q.interrupt()
  })
})

describe('QueryImpl.supportedCommands', () => {
  test('returns command names from app state', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    ;(q as any).appStateStore.setState(() => ({
      ...(q as any).appStateStore.getState(),
      mcp: {
        ...(q as any).appStateStore.getState().mcp,
        commands: [
          { name: '/help' },
          { name: '/clear' },
        ],
      },
    }))

    const cmds = q.supportedCommands()
    expect(cmds).toEqual(['/help', '/clear'])
    q.interrupt()
  })

  test('returns empty array when no commands', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    const cmds = q.supportedCommands()
    expect(cmds).toEqual([])
    q.interrupt()
  })
})

describe('QueryImpl.supportedModels', () => {
  test('returns current model as array', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    ;(q as any).appStateStore.setState(() => ({
      ...(q as any).appStateStore.getState(),
      mainLoopModel: 'claude-sonnet-4-6',
    }))

    const models = q.supportedModels()
    expect(models).toEqual(['claude-sonnet-4-6'])
    q.interrupt()
  })

  test('returns empty array when no model set', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    ;(q as any).appStateStore.setState(() => ({
      ...(q as any).appStateStore.getState(),
      mainLoopModel: undefined,
    }))

    const models = q.supportedModels()
    expect(models).toEqual([])
    q.interrupt()
  })
})

describe('QueryImpl.setMaxThinkingTokens', () => {
  test('enables thinking with budget', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    q.setMaxThinkingTokens(10000)

    const state = (q as any).appStateStore.getState()
    expect(state.thinkingEnabled).toBe(true)
    expect(state.thinkingBudgetTokens).toBe(10000)
    q.interrupt()
  })

  test('disables thinking when tokens is 0', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    // First enable
    q.setMaxThinkingTokens(5000)
    // Then disable
    q.setMaxThinkingTokens(0)

    const state = (q as any).appStateStore.getState()
    expect(state.thinkingEnabled).toBe(false)
    expect(state.thinkingBudgetTokens).toBeUndefined()
    q.interrupt()
  })
})

describe('QueryImpl.rewindFiles', () => {
  test('returns canRewind false when no file history', async () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    const result = await q.rewindFiles()
    expect(result.canRewind).toBe(false)
    q.interrupt()
  })
})

// setPermissionMode is tested via buildPermissionContext in permissions.test.ts
// (mode mapping, additionalDirectories, bypass flag). The QueryImpl.setPermissionMode
// method delegates to buildPermissionContext + getTools + engine.updateTools — the
// latter two depend on CI environment state, so integration tests are fragile.
