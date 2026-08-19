import type {
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { DESIGN_CONSENT_BIT } from '../../services/design/constants.js'
import { designGateFailure } from '../../services/design/gate.js'
import {
  grantDesignConsent,
  grantDesignProject,
  readDesignConsent,
  readDesignProjectGrants,
} from '../../services/design/control.js'
import { resolveDesignAccessToken } from '../../services/design/auth.js'
import {
  buildTool,
  type ToolDef,
  type ToolUseContext,
  type ValidationResult,
} from '../../Tool.js'
import {
  KNOWN_OPERATIONS,
  operationMetadata,
  validateDesignOperation,
} from './catalog.js'
import {
  callClaudeDesignOperation,
  DesignConsentRequiredError,
  DesignProjectGrantRequiredError,
} from './client.js'
import {
  approvedMcpPlanAllows,
  recordApprovedMcpPlan,
  tokenlessWriteTargets,
} from './permissions.js'
import { verifyDesignProjectIdentity } from './projectIdentity.js'
import { CLAUDE_DESIGN_PROMPT } from './prompt.js'
import {
  claudeDesignInputSchema,
  claudeDesignOutputSchema,
  type ClaudeDesignInput,
  type ClaudeDesignOutput,
} from './schemas.js'

type InternalInput = ClaudeDesignInput & {
  __consentBitShown?: typeof DESIGN_CONSENT_BIT
  __projectGrantAskShown?: string
  __approvalCanReachUser?: boolean
}

function operationLabel(operation?: string): string {
  switch (operation) {
    case 'list':
      return 'List operations'
    case 'list_design_systems':
      return 'List design systems'
    case 'get_claude_design_prompt':
      return 'Get design prompt'
    case 'list_projects':
      return 'List projects'
    case 'get_project':
      return 'Read project metadata'
    case 'list_files':
      return 'List project files'
    case 'read_file':
      return 'Read file'
    case 'get_conversation':
      return 'Read conversation'
    case 'list_members':
      return 'List project members'
    case 'create_project':
      return 'Create project'
    case 'put_conversation':
      return 'Write conversation'
    case 'finalize_plan':
      return 'Finalize plan'
    case 'write_files':
      return 'Write files'
    case 'copy_files':
      return 'Copy files'
    case 'delete_files':
      return 'Delete files'
    case 'render_preview':
      return 'Render preview'
    case 'create_support_js':
      return 'Create support.js'
    case 'add_member':
      return 'Add project member'
    case 'update_member_role':
      return 'Update member role'
    case 'remove_member':
      return 'Remove project member'
    case 'update_sharing':
      return 'Update sharing'
    default:
      return operation ?? ''
  }
}

function consentMessage(): string {
  return 'Connect to Claude Design? Claude can read and edit your Design projects from this tool. Change anytime at claude.ai/design/settings or with /design revoke.'
}

function safetyReason(reason: string) {
  return {
    type: 'safetyCheck' as const,
    reason,
    classifierApprovable: false,
  }
}

function approvalCanReachUser(context: ToolUseContext): boolean {
  const permissions = context.getAppState().toolPermissionContext
  return (
    !context.options.isNonInteractiveSession &&
    permissions.mode !== 'bypassPermissions' &&
    !(
      permissions.mode === 'plan' &&
      permissions.isBypassPermissionsModeAvailable
    )
  )
}

function projectId(args: Record<string, unknown>): string | null {
  return typeof args.project_id === 'string' && args.project_id
    ? args.project_id
    : null
}

export const ClaudeDesignTool = buildTool({
  name: 'ClaudeDesign',
  searchHint: 'work with Claude Design (claude.ai/design) projects',
  maxResultSizeChars: 100_000,
  isEnabled() {
    return designGateFailure() === null
  },
  get inputSchema() {
    return claudeDesignInputSchema()
  },
  get outputSchema() {
    return claudeDesignOutputSchema()
  },
  isConcurrencySafe(input) {
    if (input.operation === 'list') return true
    return operationMetadata(input.operation)?.readOnly === true
  },
  isReadOnly(input) {
    if (input.operation === 'list') return true
    return operationMetadata(input.operation)?.readOnly === true
  },
  isDestructive(input) {
    return operationMetadata(input.operation)?.destructive === true
  },
  async description() {
    return CLAUDE_DESIGN_PROMPT
  },
  async prompt() {
    return CLAUDE_DESIGN_PROMPT
  },
  userFacingName(input) {
    const label = operationLabel(input?.operation)
    return label ? `Claude Design: ${label}` : 'Claude Design'
  },
  getToolUseSummary(input) {
    return input?.operation ? operationLabel(input.operation) : null
  },
  toAutoClassifierInput(input) {
    return { operation: input.operation, arguments: input.arguments ?? {} }
  },
  renderToolUseMessage(input) {
    return operationLabel(input.operation)
  },
  async validateInput(input): Promise<ValidationResult> {
    const error = validateDesignOperation(input.operation, input.arguments)
    if (error) return { result: false, message: error, errorCode: 1 }
    if (input.operation === 'finalize_plan') {
      const id = projectId(input.arguments)
      if (!id) {
        return {
          result: false,
          message:
            'ClaudeDesign finalize_plan: project_id is required (a plan is always scoped to one project).',
          errorCode: 1,
        }
      }
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        return {
          result: false,
          message:
            'ClaudeDesign finalize_plan: project_id contains characters outside the server id charset (letters, digits, dot, underscore, dash).',
          errorCode: 1,
        }
      }
      if (id.length > 78) {
        return {
          result: false,
          message:
            'ClaudeDesign finalize_plan: project_id is longer than any server-issued project id.',
          errorCode: 1,
        }
      }
    }
    return { result: true }
  },
  async checkPermissions(input, context) {
    const auth = await resolveDesignAccessToken(context.abortController.signal)
    let needsConsent = false
    if (auth.ok && input.operation !== 'list') {
      try {
        needsConsent =
          (await readDesignConsent(auth.accessToken, context.abortController.signal)) ===
          false
      } catch {
        // Fall through to the canonical 403 response when preflight is unavailable.
      }
    }
    const withConsent = {
      ...input,
      ...(needsConsent
        ? { __consentBitShown: DESIGN_CONSENT_BIT }
        : {}),
      __approvalCanReachUser: approvalCanReachUser(context),
    } as ClaudeDesignInput
    if (
      input.operation === 'finalize_plan' &&
      input.arguments.scope === 'project'
    ) {
      return {
        behavior: 'deny',
        message:
          'ClaudeDesign finalize_plan: scope "project" is no longer supported by this client. Write files directly without plan_token — the first write to a project asks for a one-time durable approval — or use finalize_plan with writes/deletes for path-scoped plans and deletes.',
        decisionReason: safetyReason(
          'finalize_plan scope:"project" is superseded by the durable per-project write grant',
        ),
      }
    }
    if (
      input.operation === 'copy_files' &&
      !(typeof input.arguments.plan_token === 'string' &&
        input.arguments.plan_token)
    ) {
      return {
        behavior: 'deny',
        message:
          'ClaudeDesign copy_files: copying without a plan_token always requires per-batch approval — use finalize_plan declaring every destination in writes, then pass the returned plan_token.',
        decisionReason: safetyReason(
          'tokenless copy_files is per-batch-only — its destinations have no reserved-path or grant-approval flow',
        ),
      }
    }
    const metadata =
      input.operation === 'list'
        ? { readOnly: true, destructive: false }
        : operationMetadata(input.operation)
    const writes = metadata?.readOnly !== true

    if (needsConsent) {
      return {
        behavior: 'ask',
        message: [
          consentMessage(),
          writes ? `Design ${input.operation} writes to claude.ai/design.` : '',
          input.operation === 'finalize_plan'
            ? 'Approving also lets writes and deletes to exactly these paths run without another prompt for up to 15 minutes (file contents are not shown again; anything to any other path will still ask).'
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        updatedInput: withConsent,
        decisionReason: safetyReason(
          'design agent consent — approving records a server-side grant for Claude agents to read and write your design projects',
        ),
      }
    }
    if (!writes) return { behavior: 'allow', updatedInput: withConsent }
    if (
      typeof input.arguments.plan_token === 'string' &&
      approvedMcpPlanAllows(input.operation, input.arguments)
    ) {
      return { behavior: 'allow', updatedInput: withConsent }
    }

    if (
      (input.operation === 'write_files' ||
        input.operation === 'create_support_js') &&
      !(typeof input.arguments.plan_token === 'string' &&
        input.arguments.plan_token)
    ) {
      const targets = tokenlessWriteTargets(input.operation, input.arguments)
      if (targets.outcome !== 'pass') {
        return {
          behavior: 'deny',
          message:
            targets.outcome === 'empty'
              ? `ClaudeDesign ${input.operation}: this call names no target paths — list the files to write, or use finalize_plan with writes (and deletes if needed), then pass the returned plan_token.`
              : `ClaudeDesign ${input.operation}: this batch includes paths that always require per-batch approval — use finalize_plan with writes/deletes and pass the returned plan_token.`,
          decisionReason: safetyReason(
            targets.outcome === 'empty'
              ? 'a write batch naming no target paths — malformed call'
              : 'reserved or unenumerable target paths always require per-batch approval',
          ),
        }
      }
      const id = projectId(input.arguments)
      if (!id) {
        return {
          behavior: 'deny',
          message: `ClaudeDesign ${input.operation}: project_id is required for a durable write grant.`,
          decisionReason: safetyReason(
            'durable project write grants are scoped to a server project id',
          ),
        }
      }
      if (context.options.isNonInteractiveSession) {
        return {
          behavior: 'deny',
          message: `ClaudeDesign ${input.operation}: writing without a plan_token requires a one-time interactive project approval, which is not available in non-interactive sessions — use finalize_plan with writes (and deletes if needed), then pass the returned plan_token.`,
          decisionReason: safetyReason(
            'a durable project write grant requires an interactive approval with a server-verified project identity',
          ),
        }
      }
      if (
        context.agentId !== undefined ||
        context.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts
      ) {
        return {
          behavior: 'deny',
          message: `ClaudeDesign ${input.operation}: writing without a plan_token requires a one-time project approval, which is not available in subagent or PermissionRequest-hook sessions — use finalize_plan with writes (and deletes if needed), then pass the returned plan_token.`,
          decisionReason: safetyReason(
            'a durable project write grant requires a context where the approval card reaches the user directly',
          ),
        }
      }
      if (auth.ok) {
        try {
          const grants = await readDesignProjectGrants(
            auth.accessToken,
            context.abortController.signal,
          )
          if (grants?.has(id)) {
            return { behavior: 'allow', updatedInput: withConsent }
          }
          if (grants === null) {
            return {
              behavior: 'deny',
              message: `ClaudeDesign ${input.operation}: could not check for a project write grant (this server may not support durable grants) — use finalize_plan with writes (and deletes if needed), then pass the returned plan_token.`,
              decisionReason: safetyReason(
                'the grant state could not be verified — fail toward the per-batch plan flow',
              ),
            }
          }
        } catch {
          return {
            behavior: 'deny',
            message: `ClaudeDesign ${input.operation}: could not check for a project write grant — use finalize_plan with writes (and deletes if needed), then pass the returned plan_token.`,
            decisionReason: safetyReason(
              'the grant state could not be verified — fail toward the per-batch plan flow',
            ),
          }
        }
      } else {
        return {
          behavior: 'deny',
          message: `ClaudeDesign ${input.operation}: could not verify a project write grant without a design-capable credential — authenticate, or use finalize_plan with writes (and deletes if needed), then pass the returned plan_token.`,
          decisionReason: safetyReason(
            'the grant state could not be verified — fail toward the per-batch plan flow',
          ),
        }
      }
      let identity
      try {
        const project = await callClaudeDesignOperation(
          'get_project',
          { project_id: id },
          context.abortController.signal,
        )
        identity = project.isError
          ? null
          : verifyDesignProjectIdentity(id, project.content)
      } catch {
        identity = null
      }
      if (!identity) {
        return {
          behavior: 'deny',
          message: `ClaudeDesign ${input.operation}: a durable project write grant is only offered when the approval dialog can name its target, and the project identity (name, sharing, URL) could not be verified or rendered faithfully. If this is a fresh connection, read the project first (e.g. get_project — approve the Claude Design connection if prompted) and retry once; otherwise use finalize_plan with writes/deletes and pass the returned plan_token (the per-batch flow), which is always supported.`,
          decisionReason: safetyReason(
            'a durable project write grant requires a server-verified project identity in the approval card',
          ),
        }
      }
      return {
        behavior: 'ask',
        message: `Approving writes the listed files now, and lets Claude write to ANY file in the project "${identity.name}" (${identity.sharingLabel}) — ${identity.url} — without asking again. This approval is remembered for this project until you revoke it in settings at claude.ai/design (future writes and file contents are not shown for approval). Deletes and CLAUDE.md/.claude paths still ask every time.`,
        updatedInput: {
          ...withConsent,
          __projectGrantAskShown: id,
          __approvalCanReachUser: approvalCanReachUser(context),
        } as ClaudeDesignInput,
        decisionReason: safetyReason(
          'durable project write grant — approving records a server-side project grant',
        ),
      }
    }

    return {
      behavior: 'ask',
      message: [
        `Design ${input.operation} writes to claude.ai/design.`,
        input.operation === 'finalize_plan'
          ? 'Approving also lets writes and deletes to exactly these paths run without another prompt for up to 15 minutes (file contents are not shown again; anything to any other path will still ask).'
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      updatedInput: withConsent,
      decisionReason: safetyReason('Claude Design write operation'),
    }
  },
  async call(input, context) {
    const internal = input as InternalInput
    if (
      input.operation === 'copy_files' &&
      !(typeof input.arguments.plan_token === 'string' &&
        input.arguments.plan_token)
    ) {
      throw new Error(
        'copy_files without a plan_token always requires per-batch approval — use finalize_plan declaring every destination in writes, then pass the returned plan_token.',
      )
    }
    if (
      (input.operation === 'write_files' ||
        input.operation === 'create_support_js') &&
      !(typeof input.arguments.plan_token === 'string' &&
        input.arguments.plan_token) &&
      tokenlessWriteTargets(input.operation, input.arguments).outcome !== 'pass'
    ) {
      throw new Error(
        `${input.operation} without a plan_token: this batch includes paths that always require per-batch approval — use finalize_plan with writes (and deletes if needed), then pass the returned plan_token.`,
      )
    }
    const auth = await resolveDesignAccessToken(context.abortController.signal)
    if (!auth.ok) {
      throw new Error(`Claude Design authentication unavailable: ${auth.reason}`)
    }
    let consentRetried = false
    let projectGrantRetried = false
    const execute = async (): Promise<ClaudeDesignOutput> => {
      try {
        return (await callClaudeDesignOperation(
          input.operation,
          input.arguments,
          context.abortController.signal,
        )) as ClaudeDesignOutput
      } catch (error) {
        if (
          error instanceof DesignConsentRequiredError &&
          internal.__consentBitShown === DESIGN_CONSENT_BIT &&
          internal.__approvalCanReachUser === true &&
          approvalCanReachUser(context) &&
          !consentRetried
        ) {
          consentRetried = true
          await grantDesignConsent(
            auth.accessToken,
            context.abortController.signal,
          )
          return execute()
        }
        if (
          error instanceof DesignProjectGrantRequiredError &&
          internal.__projectGrantAskShown === error.projectId &&
          internal.__approvalCanReachUser === true &&
          approvalCanReachUser(context) &&
          !projectGrantRetried
        ) {
          projectGrantRetried = true
          await grantDesignProject(
            auth.accessToken,
            error.projectId,
            context.abortController.signal,
          )
          return execute()
        }
        throw error
      }
    }
    try {
      const output = await execute()
      if (input.operation === 'finalize_plan' && !output.isError) {
        recordApprovedMcpPlan(input.arguments, output.content)
      }
      return { data: output as ClaudeDesignOutput }
    } catch (error) {
      if (error instanceof DesignConsentRequiredError) {
        throw new Error(
          `${consentMessage()} The user hasn't granted this yet — ask them to retry or run /design consent.`,
        )
      }
      if (error instanceof DesignProjectGrantRequiredError) {
        throw new Error(
          `ClaudeDesign ${input.operation}: project ${error.projectId} requires a durable write grant. Retry interactively or use finalize_plan and pass its plan_token.`,
        )
      }
      if (context.abortController.signal.aborted) {
        throw context.abortController.signal.reason
      }
      throw error
    }
  },
  mapToolResultToToolResultBlockParam(
    output,
    toolUseID,
  ): ToolResultBlockParam {
    const content: Array<TextBlockParam | ImageBlockParam> = []
    for (const block of output.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text })
        continue
      }
      if (
        block.type === 'image' &&
        typeof block.data === 'string' &&
        typeof block.mimeType === 'string' &&
        /^(?:image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(
          block.mimeType,
        )
      ) {
        if (block.data.length > 130_000) {
          content.push({
            type: 'text',
            text: `[render_preview image omitted — ${Math.round(block.data.length / 1024)}KB exceeds ${Math.round(130_000 / 1024)}KB cap]`,
          })
        } else {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.mimeType as
                | 'image/png'
                | 'image/jpeg'
                | 'image/gif'
                | 'image/webp',
              data: block.data,
            },
          })
        }
        continue
      }
      content.push({ type: 'text', text: JSON.stringify(block) })
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.isError
        ? content
            .flatMap(block => (block.type === 'text' ? [block.text] : []))
            .join('\n')
            .trim() || '(error with no message)'
        : content.length > 0
          ? content
          : '(empty result)',
      ...(output.isError ? { is_error: true } : {}),
    }
  },
} satisfies ToolDef<ReturnType<typeof claudeDesignInputSchema>, ClaudeDesignOutput>)

export { KNOWN_OPERATIONS }
