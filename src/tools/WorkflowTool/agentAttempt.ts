import {workflowHostError} from './hostBoundary.ts'

// ZNp.jt (2.1.226): a single real runAgent stream, not an inference client.
// The caller supplies the permission-checked runAgent invocation and wraps the
// entire consumption in its agent ALS/cwd context. No tools are granted here.
export type WorkflowAgentMessage = {
  type: string
  attachment?: {type: string; data?: unknown}
  op?: {action: string; ids: Iterable<string>}
  isApiErrorMessage?: boolean
  message?: {
    content: string | Array<{type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean}>
    usage?: Record<string, unknown>
    model?: string
    stop_reason?: string | null
  }
}
export type WorkflowAttemptResult = {
  structured: unknown
  text: string
  agentMessages?: WorkflowAgentMessage[]
  apiError?: string
  tokens: number
  toolCalls: number
  stalled: boolean
  stalledReason?: 'stalled' | 'user-retry'
  skipped: boolean
  durationMs: number
  stopReason?: string | null
  outputTokens?: number
  structuredOutputAttempts: number
  lastStructuredOutputInput: unknown
}
export type WorkflowAttemptOptions = {
  signal?: AbortSignal
  stallMs: number
  autoMode: boolean
  structured: boolean
  maxStructuredOutputRetries: number
  makeStream(controller: AbortController, onQueryProgress: () => void): AsyncIterable<WorkflowAgentMessage>
  onController(controller: AbortController | null): void
  onProgress(state: 'start' | 'progress' | 'done' | 'error', fields: Record<string, unknown>): void
  countTokens(usage: Record<string, unknown> | undefined): number
  summarizeToolInput(input: unknown): string | undefined
  onModel(model: string): void
}
export function workflowAbortReason(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason
  if (reason instanceof Error || reason instanceof DOMException) return reason.message
  return undefined
}
export function workflowResultPreview(value: unknown): string | undefined {
  if (value == null) return undefined
  const text = (typeof value === 'string' ? value : JSON.stringify(value)).trim()
  return text ? text.length > 400 ? text.slice(0,400) + '…' : text : undefined
}

export async function runWorkflowAgentAttempt(options: WorkflowAttemptOptions): Promise<WorkflowAttemptResult> {
  const startedAt = Date.now(), controller = new AbortController()
  const parentAbort = () => controller.abort(new DOMException('workflow-abort','AbortError'))
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastLivenessReset = 0
  const inProgress = new Set<string>(), structuredCalls = new Set<string>()
  const agentMessages: WorkflowAgentMessage[] | undefined = options.autoMode ? [] : undefined
  let structured: unknown, last: WorkflowAgentMessage | undefined, tokens = 0, toolCalls = 0
  let structuredOutputAttempts = 0, failedStructuredCalls = 0, lastStructuredOutputInput: unknown
  let lastToolName: string | undefined, lastToolSummary: string | undefined
  function arm() {
    clearTimeout(timer)
    timer = undefined
    if (options.stallMs > 0) timer = setTimeout(() => controller.abort(new DOMException('stalled','AbortError')), options.stallMs)
  }
  function toolFinished() { if (inProgress.size === 0 && timer === undefined) arm() }
  function onQueryProgress() {
    if (inProgress.size) return
    const now = Date.now()
    if (now - lastLivenessReset < Math.min(options.stallMs * 0.1, 1000)) return
    lastLivenessReset = now
    arm()
  }
  function progress(state: 'start'|'progress'|'done'|'error', fields: Record<string, unknown> = {}) {
    options.onProgress(state,{tokens,toolCalls,durationMs:Date.now()-startedAt,lastToolName,lastToolSummary,...fields})
  }
  function result(fields: Partial<WorkflowAttemptResult> = {}): WorkflowAttemptResult {
    return {structured,text:'',agentMessages,tokens,toolCalls,stalled:false,skipped:false,
      durationMs:Date.now()-startedAt,structuredOutputAttempts,lastStructuredOutputInput,...fields}
  }
  options.signal?.addEventListener('abort',parentAbort)
  if (options.signal?.aborted) parentAbort()
  try {
    options.onController(controller)
    progress('start')
    arm()
    // A runAgent generator must honour its controller and throw on abort.
    // Never detach consumption with Promise.race: journal leases may only be
    // released once actual child execution has stopped.
    for await (const event of options.makeStream(controller,onQueryProgress)) {
      if (event.type === 'attachment' && event.attachment?.type === 'structured_output') {
        structured = event.attachment.data
        continue
      }
      if (event.type === 'set_in_progress_tool_use_ids') {
        if (event.op?.action === 'remove') {
          for (const id of event.op.ids) inProgress.delete(id)
          toolFinished()
        }
        continue
      }
      if (event.type === 'user') {
        agentMessages?.push(event)
        if (Array.isArray(event.message?.content)) {
          for (const block of event.message.content) if (block.type === 'tool_result' && block.tool_use_id) {
            inProgress.delete(block.tool_use_id)
            if (structuredCalls.delete(block.tool_use_id) && block.is_error) failedStructuredCalls++
          }
          toolFinished()
          if (failedStructuredCalls > 0 && failedStructuredCalls >= options.maxStructuredOutputRetries && structured === undefined) {
            throw Error(`agent({schema}): StructuredOutput retry cap (${options.maxStructuredOutputRetries}) exceeded — ${failedStructuredCalls} failed ${failedStructuredCalls === 1 ? 'call' : 'calls'} with no valid output`)
          }
        }
        continue
      }
      if (event.type !== 'assistant') continue
      last = event
      agentMessages?.push(event)
      if (!event.isApiErrorMessage) {
        tokens = options.countTokens(event.message?.usage)
        if (event.message?.model) options.onModel(event.message.model)
      }
      let calls = 0
      if (Array.isArray(event.message?.content)) for (const block of event.message.content) {
        if (block.type !== 'tool_use' || !block.id) continue
        calls++
        inProgress.add(block.id)
        lastToolName = block.name
        lastToolSummary = options.summarizeToolInput(block.input)
        if (block.name === 'StructuredOutput') {
          structuredOutputAttempts++
          lastStructuredOutputInput = block.input
          structuredCalls.add(block.id)
          if (structured !== undefined && structuredOutputAttempts > 2) {
            controller.abort('stalled')
            break
          }
        }
      }
      toolCalls += calls
      if (calls) {clearTimeout(timer);timer = undefined} else onQueryProgress()
      progress('progress')
    }
    if (controller.signal.aborted) throw Error('Workflow agent aborted')
  } catch (error) {
    const reason = controller.signal.aborted ? workflowAbortReason(controller.signal.reason) : undefined
    if (reason === 'stalled' || reason === 'user-retry') {
      if (reason === 'stalled' && structured !== undefined) {
        progress('done',{resultPreview:workflowResultPreview(structured)})
        return result()
      }
      progress('error',{error:reason === 'stalled' ? `stalled — no progress for ${options.stallMs}ms` : 'retry requested by user'})
      return result({structured:undefined,stalled:true,stalledReason:reason})
    }
    if (reason === 'user-skip') {
      progress('error',{error:'skipped by user',skipped:true})
      return result({structured:undefined,skipped:true})
    }
    progress('error',{error:workflowHostError(error).message})
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort',parentAbort)
    options.onController(null)
  }
  const content = last?.message?.content
  const text = Array.isArray(content) ? content.filter(block=>block.type==='text').map(block=>block.text??'').join('\n') : typeof content === 'string' ? content : ''
  const outputTokens = typeof last?.message?.usage?.output_tokens === 'number' ? last.message.usage.output_tokens : undefined
  const fields = {text,stopReason:last?.message?.stop_reason,outputTokens}
  if (last?.isApiErrorMessage) {
    const apiError = text || 'API error'
    progress('error',{error:apiError})
    return result({...fields,apiError})
  }
  progress('done',{resultPreview:workflowResultPreview(options.structured ? structured : text)})
  return result(fields)
}
