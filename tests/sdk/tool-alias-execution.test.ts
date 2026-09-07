import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type Tools, type ToolUseContext } from '../../src/Tool.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createAssistantMessage } from '../../src/utils/messages.js'
import { runToolUse } from '../../src/services/tools/toolExecution.js'
import { StreamingToolExecutor } from '../../src/services/tools/StreamingToolExecutor.js'
import { getDenyRuleForTool } from '../../src/utils/permissions/permissions.js'
import type { CanUseToolFn } from '../../src/hooks/useCanUseTool.js'

// Exercise the production dispatch/permission/result pipeline with inert tools.
// No shell, remote MCP server, model request or file write is involved.
function fixture(deny = false) {
  const calls: string[] = []
  const checked: string[] = []
  const targetName = 'mcp__device__shell'
  const tools = ['Bash', targetName].map(name => ({
    name,
    inputSchema: z.object({ command: z.string() }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    userFacingName: () => name,
    call: async () => { calls.push(name); return { data: 'DEVICE_RESULT' } },
    mapToolResultToToolResultBlockParam: (data: string, id: string) => ({
      type: 'tool_result', content: data, tool_use_id: id,
    }),
  })) as unknown as Tools
  let state = { ...getDefaultAppState(), toolPermissionContext: {
    ...getEmptyToolPermissionContext(), toolAliases: { Bash: targetName },
    alwaysDenyRules: deny ? { session: ['Bash'] } : {},
  } }
  const context = {
    abortController: new AbortController(), messages: [],
    options: { tools, toolAliases: { Bash: targetName }, mcpClients: [], commands: [], isNonInteractiveSession: true },
    getAppState: () => state,
    setAppState: (update: any) => { state = update(state) },
    setInProgressToolUseIDs: () => {},
    readFileState: new Map(),
  } as unknown as ToolUseContext
  const canUseTool: CanUseToolFn = async (tool, input, ctx) => {
    checked.push(tool.name)
    const rule = getDenyRuleForTool(ctx.getAppState().toolPermissionContext, tool)
    return rule ? { behavior: 'deny', message: 'DEVICE_DENIED', decisionReason: { type: 'rule', rule } }
      : { behavior: 'allow', updatedInput: input }
  }
  const block = { type: 'tool_use' as const, id: 'alias-test', name: 'Bash', input: { command: 'inert test' } }
  const assistant = createAssistantMessage({ content: [block] })
  return { calls, checked, tools, context, canUseTool, block, assistant, targetName }
}

for (const streaming of [false, true]) {
  for (const deny of [false, true]) {
    test(`${streaming ? 'streaming' : 'serial'} redirects before ${deny ? 'deny' : 'allow'} and never calls builtin`, async () => {
      const f = fixture(deny)
      let results
      if (streaming) {
        const executor = new StreamingToolExecutor(f.tools, f.canUseTool, f.context)
        executor.addTool(f.block, f.assistant)
        results = await Array.fromAsync(executor.getRemainingResults())
      } else {
        results = await Array.fromAsync(runToolUse(f.block, f.assistant, f.canUseTool, f.context))
      }
      expect(f.checked).toEqual([f.targetName])
      expect(f.calls).toEqual(deny ? [] : [f.targetName])
      const blocks = results.flatMap(update => update.message?.type === 'user' ? update.message.message.content : [])
      expect(blocks).toContainEqual(expect.objectContaining({
        type: 'tool_result', tool_use_id: f.block.id, content: deny ? 'DEVICE_DENIED' : 'DEVICE_RESULT',
        ...(deny ? { is_error: true } : {}),
      }))
    })
  }
}
