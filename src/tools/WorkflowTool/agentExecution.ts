import type {WorkflowAttemptResult} from './agentAttempt.ts'

// ZNp.Y retry/final-result policy. Permission classification and model/tool
// selection happen once before attempts; retry never bypasses those checks.
export async function finishWorkflowAgent(options: {
  label: string
  stallMs: number
  signal?: AbortSignal
  structured: boolean
  attempt(label: string, attempt: number, reason: string | undefined, cumulative: {tokens:number;toolCalls:number;durationMs:number}): Promise<WorkflowAttemptResult>
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>
  log(message: string): void
  recordFailure(message: string): void
  classifyHandoff(result: WorkflowAttemptResult, totalToolCalls: number): Promise<string | null>
}): Promise<unknown> {
  const cumulative = {tokens:0,toolCalls:0,durationMs:0}
  const accumulate = (result: WorkflowAttemptResult) => {
    cumulative.tokens += result.tokens
    cumulative.toolCalls += result.toolCalls
    cumulative.durationMs += result.durationMs
  }
  const aborted = () => {if (options.signal?.aborted) throw Error('Workflow aborted')}
  aborted()
  let result = await options.attempt(options.label,1,undefined,{...cumulative})
  const throttled = (value:WorkflowAttemptResult) => !value.stalled && !value.skipped && value.stopReason == null && value.structured === undefined && (value.outputTokens ?? Infinity) < 50 && value.durationMs > options.stallMs * 0.5
  const initiallyThrottled = throttled(result)
  if (initiallyThrottled) {
    options.log(`[${options.label}] throttled response (no stop_reason, ${result.outputTokens ?? '?'} output tokens in ${Math.round(result.durationMs/1000)}s) — sleeping 45s before retry`)
    await options.sleep(45000,options.signal)
    aborted()
    accumulate(result)
    result = await options.attempt(`${options.label} (throttle-retry)`,2,'throttled',{...cumulative})
    if (throttled(result)) options.log(`[${options.label}] throttle-retry also degraded — giving up on throttle backoff`)
  }
  const reasons:string[] = []
  for (let retry=1; result.stalled && !initiallyThrottled && retry<=5; retry++) {
    aborted()
    const reason = result.stalledReason ?? 'stalled'
    reasons.push(reason)
    let validation = ''
    if (reason === 'stalled' && result.structuredOutputAttempts > 0 && result.structured === undefined) {
      const input = JSON.stringify(result.lastStructuredOutputInput) ?? ''
      validation = ` — ${result.structuredOutputAttempts} StructuredOutput validation ${result.structuredOutputAttempts===1?'failure':'failures'} (last input: ${input.length>300?input.slice(0,300)+'…':input})`
    }
    options.log(`[stall] agent "${options.label}" ${reason==='user-retry'?'retry requested by user':'stalled (no progress)'} after ${Math.round(result.durationMs/1000)}s${validation} — retrying (${retry}/5)`)
    accumulate(result)
    result = await options.attempt(`${options.label} (retry ${retry})`,retry+1,reason,{...cumulative})
  }
  aborted()
  if (result.skipped) return null
  if (result.stalled) {
    reasons.push(result.stalledReason??'stalled')
    const validation = result.stalledReason !== 'user-retry' && result.structuredOutputAttempts>0 && result.structured===undefined ? ` — ${result.structuredOutputAttempts} StructuredOutput validation ${result.structuredOutputAttempts===1?'failure':'failures'} on the last attempt` : ''
    throw Error(reasons.every(reason=>reason==='user-retry') ? `agent abandoned: user requested retry on all ${reasons.length} attempts` : reasons.every(reason=>reason==='stalled') ? `agent stalled on all ${reasons.length} attempts (no progress for ${options.stallMs}ms each)${validation}` : `agent abandoned after ${reasons.length} attempts (${reasons.join(' → ')})${validation}`)
  }
  if (result.apiError) {
    const failure = `[${options.label}] failed: ${result.apiError}`
    options.recordFailure(failure);options.log(failure)
    return null
  }
  const handoff = await options.classifyHandoff(result,cumulative.toolCalls+result.toolCalls)
  aborted()
  if (handoff) {
    if (options.structured) {const failure=`[${options.label}] ${handoff}`;options.recordFailure(failure);options.log(failure)}
    else result.text = `${handoff}\n\n${result.text}`
  }
  if (options.structured) {
    if (result.structured === undefined) throw Error('agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)')
    return result.structured
  }
  return result.text
}
