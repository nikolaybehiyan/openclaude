import { describe, expect, test, spyOn } from 'bun:test'
import { StructuredIO } from './structuredIO.js'
import type { ToolUseContext, Tool } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import * as permissionEngine from '../utils/permissions/permissions.js'

function makeIO() {
  return new StructuredIO((async function* () {})())
}

function requestSpy(io: StructuredIO) {
  return spyOn(io as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> }, 'sendRequest')
}

const tool = { name: 'Bash' } as Tool
const context = {} as ToolUseContext
const assistant = {} as AssistantMessage

describe('noninteractive hosted permission transport', () => {
  test('allowed admin-policy decisions execute without asking the SDK', async () => {
    const io = makeIO()
    const send = requestSpy(io)
    const decision: PermissionDecision = { behavior: 'allow', updatedInput: { command: 'python3 -m pip --version' } }
    const actual = await io.createCanUseTool(undefined, true)(tool, {}, context, assistant, 'call-1', decision)
    expect(actual).toBe(decision)
    expect(send).not.toHaveBeenCalled()
  })

  test('denied policy decisions stay denied without asking the SDK', async () => {
    const io = makeIO()
    const send = requestSpy(io)
    const decision: PermissionDecision = { behavior: 'deny', message: 'Blocked by administrator policy', decisionReason: { type: 'other', reason: 'Administrator restriction' } }
    expect(await io.createCanUseTool(undefined, true)(tool, {}, context, assistant, 'call-2', decision)).toBe(decision)
    expect(send).not.toHaveBeenCalled()
  })

  test('explicit ask and interaction-only decisions fail closed without hidden prompts', async () => {
    const io = makeIO()
    const send = requestSpy(io)
    let prompted = false
    const decision: PermissionDecision = { behavior: 'ask', message: 'Explicit admin rule requires review' }
    const actual = await io.createCanUseTool(() => { prompted = true }, true)(tool, {}, context, assistant, 'call-3', decision)
    expect(actual.behavior).toBe('deny')
    expect(actual).toMatchObject({ message: decision.message })
    expect(prompted).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(io.getPendingPermissionRequests()).toHaveLength(0)
  })

  test('sandbox allowlist misses stay blocked without network permission requests', async () => {
    const io = makeIO()
    const send = requestSpy(io)
    expect(await io.createSandboxAskCallback(true)({ host: 'blocked.example', port: 443 })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  test('ordinary Code sessions retain the interactive network approval flow', async () => {
    const io = makeIO()
    const send = requestSpy(io).mockResolvedValue({ behavior: 'allow' })
    expect(await io.createSandboxAskCallback()({ host: 'review.example', port: 443 })).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('native Auto checks get headless context without changing admin rules or shared state', async () => {
    const state = { toolPermissionContext: { mode: 'auto', alwaysAllowRules: { flagSettings: ['Read'] }, alwaysDenyRules: { policySettings: ['WebFetch'] } } }
    const ctx = { getAppState: () => state } as unknown as ToolUseContext
    const check = spyOn(permissionEngine, 'hasPermissionsToUseTool').mockImplementation(async (_tool, _input, nativeContext) => {
      expect(nativeContext.getAppState().toolPermissionContext as unknown).toEqual({ ...state.toolPermissionContext, shouldAvoidPermissionPrompts: true })
      return { behavior: 'deny', message: 'Administrator restriction', decisionReason: { type: 'other', reason: 'Administrator restriction' } }
    })
    try {
      const io = makeIO()
      const send = requestSpy(io)
      expect((await io.createCanUseTool(undefined, true)(tool, {}, ctx, assistant, 'call-native')).behavior).toBe('deny')
      expect(check).toHaveBeenCalledTimes(1)
      expect(state.toolPermissionContext).not.toHaveProperty('shouldAvoidPermissionPrompts')
      expect(send).not.toHaveBeenCalled()
    } finally {
      check.mockRestore()
    }
  })

  test('classifier circuit-breaker errors propagate to the native error result instead of prompting', async () => {
    const failure = new Error('Agent aborted: too many classifier denials in headless mode')
    const check = spyOn(permissionEngine, 'hasPermissionsToUseTool').mockRejectedValue(failure)
    try {
      const io = makeIO()
      const send = requestSpy(io)
      await expect(io.createCanUseTool(undefined, true)(tool, {}, context, assistant, 'call-abort')).rejects.toBe(failure)
      expect(send).not.toHaveBeenCalled()
      expect(io.getPendingPermissionRequests()).toHaveLength(0)
    } finally {
      check.mockRestore()
    }
  })
})
