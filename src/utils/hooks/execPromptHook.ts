import { randomUUID } from 'crypto'
import { isPromptTooLongMessage } from '../../services/api/errors.js'
import { roughTokenCountEstimationForMessage } from '../../services/tokenEstimation.js'
import { getContextWindowForModel } from '../context.js'
import { tokenCountFromLastAPIResponse } from '../tokens.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { safeParseJSON } from '../json.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import type { PromptHook } from '../settings/types.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { addArgumentsToPrompt, hookResponseSchema } from './hookHelpers.js'

/**
 * Execute a prompt-based hook using an LLM
 */
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  // Use provided toolUseID or generate a new one
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`
  try {
    // Replace $ARGUMENTS with the JSON input
    const isStop = hookEvent === 'Stop' || hookEvent === 'SubagentStop'
    const condition = isStop
      ? `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\n\nCondition: ${hook.prompt}`
      : hook.prompt
    const processedPrompt = addArgumentsToPrompt(condition, jsonInput)
    logForDebugging(
      `Hooks: Processing prompt hook with prompt: ${processedPrompt}`,
    )

    // Create user message directly - no need for processUserInput which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    const userMessage = createUserMessage({ content: processedPrompt })

    // Prepend conversation history if provided
    const model = hook.model ?? getSmallFastModel()
    const makeMessages = (fraction = 0.5, maxTokens?: number) => messages?.length
      ? [...trimHookTranscript(messages, model, fraction, maxTokens), userMessage]
      : [userMessage]
    let messagesToQuery = makeMessages()

    logForDebugging(
      `Hooks: Querying model with ${messagesToQuery.length} messages`,
    )

    // Query the model with Haiku
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 30000

    // Combined signal: aborts if either the hook signal or timeout triggers
    const { signal: combinedSignal, cleanup: cleanupSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })

    try {
      const evaluate = (transcript: Message[]) => queryModelWithoutStreaming({
        messages: transcript,
        systemPrompt: asSystemPrompt([isStop ? STOP_CONDITION_SYSTEM_PROMPT : HOOK_CONDITION_SYSTEM_PROMPT]),
        thinkingConfig: { type: 'disabled' as const },
        tools: [],
        signal: combinedSignal,
        options: {
          async getToolPermissionContext() {
            const appState = toolUseContext.getAppState()
            return appState.toolPermissionContext
          },
          model,
          toolChoice: undefined,
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          agents: [],
          querySource: 'hook_prompt',
          mcpTools: [],
          agentId: toolUseContext.agentId,
          outputFormat: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                reason: { type: 'string' },
                impossible: { type: 'boolean' },
              },
              required: ['ok', 'reason'],
              additionalProperties: false,
            },
          },
        },
      })

      let response = await evaluate(messagesToQuery)
      if (isPromptTooLongMessage(response) && messages?.length) {
        // A provider may omit or under-report usage. After an actual overflow,
        // bypass that fast path and shrink the history we just sent, retaining
        // the complete latest API round even when that round alone is too big.
        const retryBudget = Math.floor(estimateTranscriptTokens(messagesToQuery.slice(0, -1)) / 2)
        messagesToQuery = makeMessages(0.25, retryBudget)
        response = await evaluate(messagesToQuery)
      }
      cleanupSignal()
      if (response.isApiErrorMessage) {
        return { hook, outcome: 'non_blocking_error', message: createAttachmentMessage({
          type: 'hook_non_blocking_error', hookName, hookEvent, toolUseID: effectiveToolUseID,
          stderr: `Hook evaluator API error: ${extractTextContent(response.message.content).trim()}`,
          stdout: '', exitCode: 1,
        }) }
      }

      // Extract text content from response
      const content = extractTextContent(response.message.content)

      // Update response length for spinner display
      toolUseContext.setResponseLength(length => length + content.length)

      const fullResponse = content.trim()
      logForDebugging(`Hooks: Model response: ${fullResponse}`)

      const json = safeParseJSON(fullResponse.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim())
      if (!json) {
        logForDebugging(
          `Hooks: error parsing response as JSON: ${fullResponse}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: 'JSON validation failed',
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      const parsed = hookResponseSchema().safeParse(json)
      if (!parsed.success) {
        logForDebugging(
          `Hooks: model response does not conform to expected schema: ${parsed.error.message}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Schema validation failed: ${parsed.error.message}`,
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      // Failed to meet condition
      if (!parsed.data.ok) {
        if (isStop && parsed.data.impossible === true) {
          return { hook, outcome: 'success', impossible: true, stopReason: parsed.data.reason,
            message: createAttachmentMessage({ type: 'hook_success', hookName, hookEvent,
              toolUseID: effectiveToolUseID, content: '' }) }
        }
        logForDebugging(
          `Hooks: Prompt hook condition was not met: ${parsed.data.reason}`,
        )
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `[${hook.prompt}]: ${parsed.data.reason}`,
            command: hook.prompt,
          },
          preventContinuation: !isStop && (hook as PromptHook & {continueOnBlock?: boolean}).continueOnBlock !== true,
          stopReason: parsed.data.reason,
        }
      }

      // Condition was met
      logForDebugging(`Hooks: Prompt hook condition was met`)
      return {
        hook,
        outcome: 'success',
        stopReason: parsed.data.reason,
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }),
      }
    } catch (error) {
      cleanupSignal()

      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Prompt hook error: ${errorMsg}`)
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing prompt hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }),
    }
  }
}

// Exact 2.1.226 evaluator instructions, with the product name adapted to Darb.
export const STOP_CONDITION_SYSTEM_PROMPT = `You are evaluating a stop-condition hook in Darb. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`
export const HOOK_CONDITION_SYSTEM_PROMPT = `You are evaluating a hook condition in Darb. Judge whether the user-provided condition is met.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<reason the condition is met>"}
- {"ok": false, "reason": "<reason the condition is not met>"}

Always include a "reason" field.`

function estimateTranscriptTokens(messages: Message[]): number {
  return Math.ceil(messages.reduce((sum, message) => sum + (
    message.type === 'assistant' || message.type === 'user'
      ? roughTokenCountEstimationForMessage(message)
      : JSON.stringify(message).length / 4
  ), 0))
}

export function trimHookTranscript(messages: Message[], model: string, fraction = 0.5, maxTokens?: number): Message[] {
  const budget = Math.min(Math.floor(getContextWindowForModel(model) * fraction), maxTokens ?? Infinity)
  if (maxTokens === undefined && tokenCountFromLastAPIResponse(messages) <= budget) return messages
  // API-round boundaries from 2.1.226 bCr, including virtual/incomplete records.
  const groups: Message[][] = []
  let current: Message[] = [], lastId: string | undefined
  for (const message of messages) {
    if ((message.type === 'user' || message.type === 'assistant') && message.isVirtual === true) {
      current.push(message)
      continue
    }
    if (message.type === 'assistant' && message.message.id !== lastId &&
      !message.resumedFromIncompleteThinking && current.length) {
      groups.push(current); current = [message]
    } else current.push(message)
    if (message.type === 'assistant') lastId = message.message.id
  }
  if (current.length) groups.push(current)
  let used = 0, start = groups.length
  for (let index = groups.length - 1; index >= 0; index--) {
    const cost = estimateTranscriptTokens(groups[index]!)
    if (start < groups.length && used + cost > budget) break
    used += cost; start = index
  }
  const kept = groups.slice(start).flat(), dropped = messages.length - kept.length
  if (dropped <= 0) return messages
  return [createUserMessage({ content: `[Earlier conversation truncated to fit the hook evaluator's context window — ${dropped} earlier messages omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]` }), ...kept]
}
