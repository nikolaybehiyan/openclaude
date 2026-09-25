import type {ToolPermissionContext} from '../../Tool.js'
import type {PermissionBehavior, PermissionDecision, PermissionRule} from '../../types/permissions.js'
import {WORKFLOW_TOOL_NAME} from './constants.js'
import type {WorkflowInput} from './registry.js'

export type WorkflowPermissionInput = WorkflowInput & {args?: unknown}
export type WorkflowPermissionDecisionHost = {
  /** Production host must use the effective, current invocation permissions. */
  readPermissionContext(): ToolPermissionContext
  getRules(context: ToolPermissionContext, name: string, behavior: PermissionBehavior): ReadonlyMap<string, PermissionRule>
  readScriptPath(path: string): Promise<{script: string} | {error: string}>
  resolveNamed(name: string): Promise<{script: string} | undefined>
}

/**
 * 2.1.226 Workflow.checkPermissions: named deny > ask > allow, with reviewed
 * script bytes included in the decision. Paths and inline scripts never inherit
 * a named grant or create a persistent named-rule suggestion.
 *
 * This is the decision primitive, not public registration or approval itself.
 * The shared permission core still owns whole-tool rules, hooks and UI; the
 * caller must pass updatedInput on to the runner without reopening its path.
 */
export async function checkWorkflowPermission(
  input: WorkflowPermissionInput,
  host: WorkflowPermissionDecisionHost,
): Promise<PermissionDecision> {
  const context = host.readPermissionContext()
  const name = input.scriptPath ? undefined : input.name
  const rule = (behavior: PermissionBehavior) =>
    name ? host.getRules(context, WORKFLOW_TOOL_NAME, behavior).get(name) : undefined
  const denied = rule('deny')
  if (denied) return {behavior: 'deny', message: 'Workflow ' + name + ' blocked by permission rules',
    decisionReason: {type: 'rule', rule: denied}}

  let updatedInput = input
  if (input.scriptPath) {
    const resolved = await host.readScriptPath(input.scriptPath)
    if (!('error' in resolved)) updatedInput = {...input, script: resolved.script}
  } else if (input.name) {
    const resolved = await host.resolveNamed(input.name)
    updatedInput = {...input, script: resolved?.script}
  }
  const asked = rule('ask')
  if (asked) return {behavior: 'ask', message: 'Review dynamic workflow before running', updatedInput,
    decisionReason: {type: 'rule', rule: asked}}
  const allowed = rule('allow')
  if (allowed) return {behavior: 'allow', updatedInput, decisionReason: {type: 'rule', rule: allowed}}
  return {behavior: 'ask', message: 'Review dynamic workflow before running', updatedInput,
    ...(name ? {suggestions: [{type: 'addRules' as const, rules: [{toolName: WORKFLOW_TOOL_NAME, ruleContent: name}],
      behavior: 'allow' as const, destination: 'localSettings' as const}]} : {})}
}
