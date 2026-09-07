import { describe, expect, test } from 'bun:test'
import { findToolByName, getEmptyToolPermissionContext, type Tool, type Tools } from '../../src/Tool.js'
import { getDenyRuleForTool, getAskRuleForTool, toolAlwaysAllowedRule, getInputParamRule } from '../../src/utils/permissions/permissions.js'
import { buildPermissionContext } from '../../src/entrypoints/sdk/permissions.js'
import { SDKControlInitializeRequestSchema } from '../../src/entrypoints/sdk/controlSchemas.js'

const builtin = { name: 'Bash' } as Tool
const target = { name: 'mcp__device__shell', mcpInfo: { serverName: 'device', toolName: 'shell' } } as Tool
const third = { name: 'Third' } as Tool
const pool = [builtin, target, third] as Tools
const redirects = { Bash: target.name }

describe('2.1.221 single-hop SDK tool redirects', () => {
  test('initialize retains the two fields with strict value types', () => {
    const value = { subtype: 'initialize', appendSubagentSystemPrompt: 'DEVICE', toolAliases: redirects }
    expect(SDKControlInitializeRequestSchema().parse(value)).toEqual(value)
    expect(SDKControlInitializeRequestSchema().safeParse({ ...value, toolAliases: { Bash: 42 } }).success).toBe(false)
  })
  test('explicit mapping overrides a builtin with the same name', () => {
    expect(findToolByName(pool, 'Bash', redirects)).toBe(target)
    expect(findToolByName(pool, 'Bash')).toBe(builtin)
    expect(findToolByName(pool, target.name, redirects)).toBe(target)
  })
  test('never follows a redirect chain or loops', () => {
    expect(findToolByName(pool, 'Bash', { Bash: target.name, [target.name]: 'Third' })).toBe(target)
    expect(findToolByName(pool, 'Bash', { Bash: target.name, [target.name]: 'Bash' })).toBe(target)
    expect(findToolByName(pool, 'Bash', { Bash: 'Bash' })).toBe(builtin)
  })
  test('does not fall back to the builtin for an unavailable mapped target', () => {
    expect(findToolByName(pool, 'Bash', { Bash: 'missing' })).toBeUndefined()
  })
  test('ignores inherited mappings and preserves legacy tool aliases', () => {
    expect(findToolByName(pool, 'Bash', Object.create(redirects))).toBe(builtin)
    const renamed = { name: 'TaskStop', aliases: ['KillShell'] } as Tool
    expect(findToolByName([renamed] as Tools, 'KillShell', {})).toBe(renamed)
  })
  test('permission builder snapshots session aliases', () => {
    const input = { ...redirects }
    const context = buildPermissionContext({ cwd: '/workspace', toolAliases: input })
    input.Bash = 'Third'
    expect(context.toolAliases).toEqual(redirects)
  })
})

describe('redirect-aware policy without permission expansion', () => {
  test('policy deny/ask/allow rules follow the single hop', () => {
    const context = {
      ...getEmptyToolPermissionContext(), toolAliases: redirects,
      alwaysDenyRules: { session: ['Bash'] },
      alwaysAskRules: { session: ['Bash'] },
      alwaysAllowRules: { session: ['Bash'] },
    }
    expect(getDenyRuleForTool(context, target)?.ruleBehavior).toBe('deny')
    expect(getAskRuleForTool(context, target)?.ruleBehavior).toBe('ask')
    expect(toolAlwaysAllowedRule(context, target)?.ruleBehavior).toBe('allow')
    expect(getDenyRuleForTool(context, third)).toBeNull()
  })
  test('CLI narrowing does not turn a builtin allowance into an MCP grant', () => {
    const context = {
      ...getEmptyToolPermissionContext(), toolAliases: redirects,
      alwaysAllowRules: { cliArg: ['Bash'] }, alwaysDenyRules: { cliArg: ['Bash'] },
    }
    expect(toolAlwaysAllowedRule(context, target)).toBeNull()
    expect(getDenyRuleForTool(context, target)).toBeNull()
    expect(getDenyRuleForTool(context, builtin)?.ruleBehavior).toBe('deny')
  })
  test('canonical target/server denies still apply', () => {
    for (const rule of [target.name, 'mcp__device', 'mcp__device__*']) {
      const context = { ...getEmptyToolPermissionContext(), toolAliases: redirects, alwaysDenyRules: { cliArg: [rule] } }
      expect(getDenyRuleForTool(context, target)?.ruleBehavior).toBe('deny')
    }
  })
  test('input-parameter policy follows mapping but CLI rules remain narrow', () => {
    const context = { ...getEmptyToolPermissionContext(), toolAliases: redirects, alwaysDenyRules: { session: ['Bash(command:rm *)'] } }
    expect(getInputParamRule(context, target, { command: 'rm example' }, 'deny')?.ruleBehavior).toBe('deny')
    expect(getInputParamRule(context, target, { command: 'pwd' }, 'deny')).toBeNull()
    expect(getInputParamRule({ ...context, alwaysDenyRules: { cliArg: ['Bash(command:rm *)'] } }, target, { command: 'rm example' }, 'deny')).toBeNull()
  })
})
