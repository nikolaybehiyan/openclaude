import { describe, test, expect, vi } from 'bun:test'
import {
  buildPermissionContext,
  connectSdkMcpServers,
  createDefaultCanUseTool,
  createExternalCanUseTool,
  applyBuiltinToolsFilter,
} from '../../src/entrypoints/sdk/permissions.js'
import { getEmptyToolPermissionContext } from '../../src/Tool.js'
import { filterToolsByDenyRules } from '../../src/tools.js'

const askFallback = async () => ({
  behavior: 'ask' as const,
  message: 'Permission required',
})

function permissionTestContext() {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext }),
  } as any
}

function testTool(permissionResult: any) {
  return {
    name: 'TestTool',
    inputSchema: { parse: (input: unknown) => input },
    checkPermissions: vi.fn(async () => permissionResult),
  } as any
}

describe('buildPermissionContext', () => {
  test('returns default mode when no permissionMode specified', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp' })
    expect(ctx.mode).toBe('default')
  })

  test('maps plan mode correctly', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', permissionMode: 'plan' })
    expect(ctx.mode).toBe('plan')
  })

  test('maps auto-accept to acceptEdits', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', permissionMode: 'auto-accept' })
    expect(ctx.mode).toBe('acceptEdits')
  })

  test('maps acceptEdits mode', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', permissionMode: 'acceptEdits' })
    expect(ctx.mode).toBe('acceptEdits')
  })

  test('maps bypass-permissions mode', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', permissionMode: 'bypass-permissions' })
    expect(ctx.mode).toBe('bypassPermissions')
    expect(ctx.isBypassPermissionsModeAvailable).toBe(true)
  })

  test('maps bypassPermissions mode', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', permissionMode: 'bypassPermissions' })
    expect(ctx.mode).toBe('bypassPermissions')
    expect(ctx.isBypassPermissionsModeAvailable).toBe(true)
  })

  test('default mode does not have bypass available', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp' })
    expect(ctx.isBypassPermissionsModeAvailable).toBe(false)
  })

  test('allowDangerouslySkipPermissions sets bypass flag', () => {
    const ctx = buildPermissionContext({
      cwd: '/tmp',
      allowDangerouslySkipPermissions: true,
    })
    expect(ctx.isBypassPermissionsModeAvailable).toBe(true)
  })

  test('additionalDirectories are added to context', () => {
    const ctx = buildPermissionContext({
      cwd: '/tmp',
      additionalDirectories: ['/dir1', '/dir2'],
    })
    expect(ctx.additionalWorkingDirectories.has('/dir1')).toBe(true)
    expect(ctx.additionalWorkingDirectories.has('/dir2')).toBe(true)
  })

  test('empty additionalDirectories does nothing', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', additionalDirectories: [] })
    expect(ctx.additionalWorkingDirectories.size).toBe(0)
  })

  test('disallowedTools sets alwaysDenyRules.cliArg', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', disallowedTools: ['Bash', 'Edit'] })
    expect(ctx.alwaysDenyRules.cliArg).toEqual(['Bash', 'Edit'])
  })

  test('disallowedTools defaults to empty array', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp' })
    expect(ctx.alwaysDenyRules.cliArg).toEqual([])
  })
})

describe('disallowedTools tool filtering', () => {
  const baseTools = [{ name: 'Bash' }, { name: 'Read' }]

  test('Bash is excluded from the tool list when disallowed', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', disallowedTools: ['Bash'] })
    const tools = filterToolsByDenyRules(baseTools, ctx)
    expect(tools.some(t => t.name === 'Bash')).toBe(false)
  })

  test('disallowedTools does not affect other tools', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', disallowedTools: ['Bash'] })
    const tools = filterToolsByDenyRules(baseTools, ctx)
    expect(tools.some(t => t.name === 'Read')).toBe(true)
  })

  test('empty disallowedTools includes the tool list', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp' })
    const tools = filterToolsByDenyRules(baseTools, ctx)
    expect(tools.some(t => t.name === 'Bash')).toBe(true)
  })

  test('builtin tools filter keeps only selected built-ins', () => {
    const ctx = applyBuiltinToolsFilter(
      buildPermissionContext({ cwd: '/tmp' }),
      ['Bash', 'WebFetch', 'WebSearch'],
      ['Bash', 'Read', 'WebFetch', 'WebSearch'],
    )
    const tools = filterToolsByDenyRules([
      { name: 'Bash' },
      { name: 'Read' },
      { name: 'WebFetch' },
      { name: 'WebSearch' },
    ], ctx)
    expect(tools.map(tool => tool.name).sort()).toEqual(['Bash', 'WebFetch', 'WebSearch'])
  })
})

describe('createDefaultCanUseTool', () => {
  test('delegates tool decisions to the OpenClaude permission engine', async () => {
    const ctx = getEmptyToolPermissionContext()
    const canUseTool = createDefaultCanUseTool(ctx)

    const result = await canUseTool(
      testTool({ behavior: 'deny' as const, message: 'blocked by tool permissions' }),
      { command: 'rm -rf /' },
      permissionTestContext(),
      {} as any,
      undefined,
      undefined,
    )

    expect(result.behavior).toBe('deny')
    expect(result.message).toBe('blocked by tool permissions')
  })

  test('honors forceDecision when provided', async () => {
    const ctx = getEmptyToolPermissionContext()
    const canUseTool = createDefaultCanUseTool(ctx)

    const result = await canUseTool(
      { name: 'Bash' } as any,
      {},
      {} as any,
      {} as any,
      undefined,
      { behavior: 'allow' as const },
    )

    expect(result.behavior).toBe('allow')
  })

  test('warning not emitted at construction time', () => {
    const ctx = getEmptyToolPermissionContext()
    const logger = { warn: vi.fn() }
    createDefaultCanUseTool(ctx, logger)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('createExternalCanUseTool', () => {
  test('preserves allow and deny decisions from the OpenClaude engine', async () => {
    const userFn = vi.fn(async () => ({ behavior: 'allow' as const }))
    const allowCanUseTool = createExternalCanUseTool(
      userFn,
      async () => ({ behavior: 'allow' as const }),
    )
    const denyCanUseTool = createExternalCanUseTool(
      userFn,
      async () => ({ behavior: 'deny' as const, message: 'blocked by OpenClaude engine' }),
    )

    const allowResult = await allowCanUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'allow-id', undefined)
    const denyResult = await denyCanUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'deny-id', undefined)

    expect(allowResult.behavior).toBe('allow')
    expect(denyResult.behavior).toBe('deny')
    expect(denyResult.message).toBe('blocked by OpenClaude engine')
    expect(userFn).not.toHaveBeenCalled()
  })

  test('delegates ask decisions to canUseTool', async () => {
    const fallback = vi.fn(askFallback)
    const userFn = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: { ok: true } }))
    const canUseTool = createExternalCanUseTool(userFn, fallback)

    const result = await canUseTool({ name: 'TestTool' } as any, { raw: true }, {} as any, {} as any, 'test-id', undefined)

    expect(fallback).toHaveBeenCalledTimes(1)
    expect(userFn).toHaveBeenCalledWith('TestTool', { raw: true }, { toolUseID: 'test-id' })
    expect(result).toEqual({ behavior: 'allow', updatedInput: { ok: true } })
  })

  test('turns canUseTool deny into a source permission denial', async () => {
    const userFn = vi.fn(async () => ({ behavior: 'deny' as const, message: 'blocked by host' }))
    const canUseTool = createExternalCanUseTool(userFn, askFallback)

    const result = await canUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'test-id', undefined)

    expect(result.behavior).toBe('deny')
    expect(result.message).toBe('blocked by host')
    expect(result.decisionReason).toEqual({ type: 'mode', mode: 'default' })
  })

  test('denies ask decisions when canUseTool is absent', async () => {
    const logger = { warn: vi.fn() }
    const canUseTool = createExternalCanUseTool(undefined, askFallback, logger)

    const result = await canUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'test-id', undefined)

    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('no external handler')
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  test('includes callback errors in denial message', async () => {
    const userFn = async () => {
      throw new Error('Custom error from callback')
    }
    const canUseTool = createExternalCanUseTool(userFn, askFallback)

    const result = await canUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'test-id', undefined)

    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('Custom error from callback')
  })
})

describe('connectSdkMcpServers error handling', () => {
  test('returns empty arrays for undefined config', async () => {
    const result = await connectSdkMcpServers(undefined)

    expect(result.clients).toEqual([])
    expect(result.tools).toEqual([])
  })

  test('returns empty arrays for empty config', async () => {
    const result = await connectSdkMcpServers({})

    expect(result.clients).toEqual([])
    expect(result.tools).toEqual([])
  })
})
