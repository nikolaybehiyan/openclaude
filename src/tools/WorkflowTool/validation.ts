import {parse} from 'acorn'
import {simple} from 'acorn-walk'
import type {WorkflowInput} from './registry.js'
import {parseWorkflowScript} from './scriptParser.js'

export type WorkflowValidationResult = {result: true} | {result: false; message: string; errorCode: number}
export type WorkflowValidationHost = {
  /** Server fallback retraction, not an arbitrary abort or a cached launch flag. */
  isRetracted(): boolean
  isDisabledByManagedSettings(): boolean
  isEnabled(): boolean
  isNameOnly(): boolean
  /** Resolve bytes only. Parsing here would collapse error code 2 into code 1. */
  resolveInput(input: WorkflowInput): Promise<{script: string} | {error: string}>
  recordNamedResolution(found: boolean): void
  readTasks(): Readonly<Record<string, {type: string; status: string; workflowRunId?: string}>>
}

const retracted = (): WorkflowValidationResult => ({result: false, errorCode: 7,
  message: 'Tool dispatch was retracted by a server fallback; the input may be truncated.'})

// Match the 2.1.226 AST check, including its deliberately limited syntactic
// scope. This is validation UX, NOT the VM's security/determinism boundary.
export function hasWorkflowNondeterminism(script: string): boolean {
  let found = false
  try {
    const ast = parse(script, {ecmaVersion: 'latest', sourceType: 'module',
      allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true})
    simple(ast, {
      MemberExpression(node) {
        if (node.computed || node.object.type !== 'Identifier' || node.property.type !== 'Identifier') return
        if (node.object.name === 'Date' && node.property.name === 'now' ||
            node.object.name === 'Math' && node.property.name === 'random') found = true
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) found = true
      },
    })
  } catch { return false }
  return found
}

/** 2.1.226 public validation order. No permission grant, compilation, task
 * registration or execution occurs here; public Workflow registration stays off.
 */
export async function validateWorkflowInput(input: WorkflowInput, host: WorkflowValidationHost): Promise<WorkflowValidationResult> {
  if (host.isRetracted()) return retracted()
  if (host.isDisabledByManagedSettings()) return {result: false, errorCode: 5,
    message: 'Dynamic workflows are disabled by managed settings (`disableWorkflows`).'}
  if (!host.isEnabled()) return {result: false, errorCode: 6,
    message: 'Dynamic workflows are not enabled for this session (org policy, launch gate, or the "Dynamic workflows" setting in /config).'}
  if (host.isNameOnly()) {
    const forbidden = [input.script && 'script', input.scriptPath && 'scriptPath',
      input.resumeFromRunId && 'resumeFromRunId', input.remote && 'remote'].filter(Boolean)
    if (forbidden.length) return {result: false, errorCode: 8,
      message: `This session restricts the Workflow tool to named workflows (CLAUDE_WORKFLOW_NAME_ONLY is set). Not allowed here: ${forbidden.join(', ')}. Invoke as {name, args} only.`}
  }
  const resolved = await host.resolveInput(input)
  if (host.isRetracted()) return retracted()
  const named = Boolean(input.name && !input.scriptPath)
  if ('error' in resolved) {
    if (named) host.recordNamedResolution(false)
    return {result: false, message: resolved.error, errorCode: 1}
  }
  if (named) host.recordNamedResolution(true)
  const parsed = parseWorkflowScript(resolved.script)
  if ('error' in parsed) return {result: false, message: `Invalid workflow script: ${parsed.error}`, errorCode: 2}
  if (input.script && hasWorkflowNondeterminism(parsed.scriptBody)) return {result: false, errorCode: 4,
    message: 'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.'}
  if (input.resumeFromRunId) {
    for (const [taskId, task] of Object.entries(host.readTasks())) {
      if (task.type === 'local_workflow' && task.status === 'running' && task.workflowRunId === input.resumeFromRunId) {
        return {result: false, errorCode: 3,
          message: `Workflow ${input.resumeFromRunId} is still running (task ${taskId}). Stop it first with TaskStop({taskId: "${taskId}"}) before resuming.`}
      }
    }
  }
  return {result: true}
}
