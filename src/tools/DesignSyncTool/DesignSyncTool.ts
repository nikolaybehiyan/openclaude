import { constants } from 'fs'
import { open, realpath } from 'fs/promises'
import path from 'path'
import {
  DESIGN_CONSENT_BIT,
  DESIGN_MAX_LOCAL_FILE_BYTES,
  DESIGN_TEXT_EXTENSIONS,
} from '../../services/design/constants.js'
import { designGateFailure } from '../../services/design/gate.js'
import { grantDesignConsent, readDesignConsent } from '../../services/design/control.js'
import {
  describeDesignAuthFailure,
  resolveDesignAccessToken,
} from '../../services/design/auth.js'
import { DesignHTTPError } from '../../services/design/http.js'
import {
  buildTool,
  type ToolDef,
  type ToolUseContext,
  type ValidationResult,
} from '../../Tool.js'
import {
  createDesignSystemProject,
  deleteDesignAsset,
  deleteDesignProjectFiles,
  DesignRpcError,
  getDesignProject,
  getDesignProjectFile,
  listDesignProjectFiles,
  listDesignSystemProjects,
  recordDesignAsset,
  writeDesignProjectFiles,
} from './client.js'
import {
  assertSafeDesignPath,
  isReservedDesignPath,
  normalizeDesignPath,
  pathAllowedByPlan,
  registerDesignPlan,
  requireDesignPlan,
} from './plan.js'
import { DESIGN_SYNC_PROMPT } from './prompt.js'
import {
  designSyncInputSchema,
  designSyncOutputSchema,
  missingDesignSyncFields,
  type DesignSyncFileInput,
  type DesignSyncInput,
  type DesignSyncOutput,
} from './schemas.js'

type InternalDesignSyncInput = DesignSyncInput & {
  __consentBitShown?: typeof DESIGN_CONSENT_BIT
  __consentAskCanReachUser?: boolean
}

export class DesignSyncPreconditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesignSyncPreconditionError'
  }
}

function isReadMethod(method: DesignSyncInput['method']): boolean {
  return (
    method === 'list_projects' ||
    method === 'get_project' ||
    method === 'list_files' ||
    method === 'get_file' ||
    method === 'report_validate'
  )
}

function consentApprovalCanReachUser(context: ToolUseContext): boolean {
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

function operationLabel(input?: Partial<DesignSyncInput>): string {
  switch (input?.method) {
    case 'list_projects':
      return 'List design-system projects'
    case 'get_project':
      return 'Read project metadata'
    case 'list_files':
      return 'List project files'
    case 'get_file':
      return input.path ? `Read ${input.path}` : 'Read file'
    case 'finalize_plan':
      return `Upload design system (${input.writes?.length ?? 0} to upload, ${input.deletes?.length ?? 0} to delete)`
    case 'write_files':
      return `Write ${input.files?.length ?? 0} files`
    case 'delete_files':
      return `Delete ${input.paths?.length ?? 0} files`
    case 'register_assets':
      return `Register ${input.assets?.length ?? 0} asset cards`
    case 'unregister_assets':
      return `Unregister ${input.paths?.length ?? 0} asset cards`
    case 'create_project':
      return input.name
        ? `Create project "${input.name}"`
        : 'Create design-system project'
    case 'report_validate':
      return 'Report validate metrics'
    default:
      return 'Design sync'
  }
}

function required<T>(value: T | undefined, field: string, method: string): T {
  if (value === undefined) throw new Error(`${method} requires "${field}"`)
  return value
}

async function materializeLocalFile(
  file: DesignSyncFileInput,
  localDir: string | undefined,
) {
  const projectPath = assertSafeDesignPath(file.path)
  if (file.localPath === undefined) {
    if (file.data === undefined) {
      throw new Error(`write_files: ${projectPath} has neither data nor localPath`)
    }
    return {
      path: projectPath,
      data: file.data,
      ...(file.encoding ? { encoding: file.encoding } : {}),
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    }
  }
  if (file.data !== undefined) {
    throw new Error(`write_files: ${projectPath} has both data and localPath`)
  }
  if (!localDir) {
    throw new Error(
      'write_files with localPath requires a plan finalized with localDir. Re-run finalize_plan with the bundle directory.',
    )
  }
  const root = await realpath(localDir)
  const unresolved = path.resolve(root, file.localPath)
  const separatorRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  if (unresolved !== root && !unresolved.startsWith(separatorRoot)) {
    throw new Error(
      'write_files: localPath must be inside the directory approved at finalize_plan.',
    )
  }
  const resolved = await realpath(unresolved)
  if (resolved !== root && !resolved.startsWith(separatorRoot)) {
    throw new Error(
      'write_files: localPath resolves outside the directory approved at finalize_plan.',
    )
  }
  const handle = await open(
    resolved,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  let bytes: Buffer
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new Error('write_files: localPath must be a regular file.')
    }
    if (stat.size > DESIGN_MAX_LOCAL_FILE_BYTES) {
      throw new Error(
        `write_files: file at localPath exceeds the ${DESIGN_MAX_LOCAL_FILE_BYTES} byte limit.`,
      )
    }
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  const extension = path.extname(resolved).slice(1).toLowerCase()
  return DESIGN_TEXT_EXTENSIONS.has(extension)
    ? {
        path: projectPath,
        data: bytes.toString('utf8'),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      }
    : {
        path: projectPath,
        data: bytes.toString('base64'),
        encoding: 'base64' as const,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      }
}

async function executeDesignSync(
  input: DesignSyncInput,
  token: string,
  signal: AbortSignal,
): Promise<DesignSyncOutput> {
  switch (input.method) {
    case 'list_projects': {
      const items = await listDesignSystemProjects(token, signal)
      return {
        method: 'list_projects',
        projects: items
          .filter(
            item =>
              item.callerCanEdit ??
              item.canEdit ??
              (item.isOwned || item.sharing?.teamCanEdit) ??
              false,
          )
          .map(item => ({
            projectId: item.projectId,
            name: item.name,
            ...(typeof item.ownerDisplayName === 'string'
              ? { ownerDisplayName: item.ownerDisplayName }
              : {}),
            ...(typeof item.isOwned === 'boolean'
              ? { isOwned: item.isOwned }
              : {}),
            ...(typeof item.updatedAt === 'string'
              ? { updatedAt: item.updatedAt }
              : {}),
          })),
      }
    }
    case 'get_project': {
      const projectId = required(input.projectId, 'projectId', input.method)
      const project = await getDesignProject(token, projectId, signal)
      return {
        method: 'get_project',
        projectId: project.projectId,
        name: project.name,
        ...(typeof project.type === 'string' ? { type: project.type } : {}),
        ...(typeof project.ownerDisplayName === 'string'
          ? { ownerDisplayName: project.ownerDisplayName }
          : {}),
        ...(typeof project.isOwned === 'boolean'
          ? { isOwned: project.isOwned }
          : {}),
        ...(typeof (project.callerCanEdit ?? project.canEdit) === 'boolean'
          ? { canEdit: project.callerCanEdit ?? project.canEdit }
          : {}),
      }
    }
    case 'list_files': {
      const projectId = required(input.projectId, 'projectId', input.method)
      return {
        method: 'list_files',
        paths: await listDesignProjectFiles(token, projectId, signal),
      }
    }
    case 'get_file': {
      const projectId = required(input.projectId, 'projectId', input.method)
      const filePath = required(input.path, 'path', input.method)
      return {
        method: 'get_file',
        path: filePath,
        ...(await getDesignProjectFile(token, projectId, filePath, signal)),
      }
    }
    case 'finalize_plan': {
      const projectId = required(input.projectId, 'projectId', input.method)
      const writes = required(input.writes, 'writes', input.method).map(
        normalizeDesignPath,
      )
      const deletes = required(input.deletes, 'deletes', input.method).map(
        normalizeDesignPath,
      )
      return {
        method: 'finalize_plan',
        planId: await registerDesignPlan({
          projectId,
          writes,
          deletes,
          localDir: input.localDir,
        }),
        writes,
        deletes,
      }
    }
    case 'write_files': {
      const projectId = required(input.projectId, 'projectId', input.method)
      const plan = requireDesignPlan(
        required(input.planId, 'planId', input.method),
        projectId,
      )
      const files = required(input.files, 'files', input.method)
      const reserved = files.map(file => file.path).filter(isReservedDesignPath)
      if (reserved.length > 0) {
        throw new Error(
          `Cannot write reserved paths: ${reserved.join(', ')}. CLAUDE.md and .claude/ carry instructions to the design agent and are blocked regardless of the plan.`,
        )
      }
      const outside = files
        .map(file => assertSafeDesignPath(file.path))
        .filter(filePath => !pathAllowedByPlan(filePath, plan.writes))
      if (outside.length > 0) {
        throw new Error(
          `Cannot write paths outside the finalized plan: ${outside.join(', ')}. Re-run finalize_plan with the full set.`,
        )
      }
      const materialized: Array<Record<string, unknown>> = []
      for (let index = 0; index < files.length; index += 32) {
        if (signal.aborted) throw signal.reason
        materialized.push(
          ...(await Promise.all(
            files
              .slice(index, index + 32)
              .map(file => materializeLocalFile(file, plan.localDir)),
          )),
        )
      }
      return {
        method: 'write_files',
        written: (
          await writeDesignProjectFiles(
            token,
            projectId,
            materialized,
            signal,
          )
        ).length,
      }
    }
    case 'delete_files': {
      const projectId = required(input.projectId, 'projectId', input.method)
      const plan = requireDesignPlan(
        required(input.planId, 'planId', input.method),
        projectId,
      )
      const paths = required(input.paths, 'paths', input.method).map(
        assertSafeDesignPath,
      )
      const reserved = paths.filter(isReservedDesignPath)
      if (reserved.length > 0) {
        throw new Error(
          `Cannot delete reserved paths: ${reserved.join(', ')}. CLAUDE.md and .claude/ carry instructions to the design agent and are blocked regardless of the plan.`,
        )
      }
      const outside = paths.filter(
        filePath => !pathAllowedByPlan(filePath, plan.deletes),
      )
      if (outside.length > 0) {
        throw new Error(
          `Cannot delete paths outside the finalized plan: ${outside.join(', ')}. Re-run finalize_plan with the full set.`,
        )
      }
      return {
        method: 'delete_files',
        deleted: (
          await deleteDesignProjectFiles(token, projectId, paths, signal)
        ).length,
      }
    }
    case 'register_assets': {
      const projectId = required(input.projectId, 'projectId', input.method)
      const plan = requireDesignPlan(
        required(input.planId, 'planId', input.method),
        projectId,
      )
      const assets = required(input.assets, 'assets', input.method)
      const outside = assets
        .map(asset => assertSafeDesignPath(asset.path))
        .filter(filePath => !pathAllowedByPlan(filePath, plan.writes))
      if (outside.length > 0) {
        throw new Error(
          `Cannot register paths outside the finalized plan: ${outside.join(', ')}. Re-run finalize_plan with the full set.`,
        )
      }
      let registered = 0
      for (const asset of assets) {
        if (signal.aborted) throw signal.reason
        await recordDesignAsset(
          token,
          projectId,
          { ...asset, path: assertSafeDesignPath(asset.path) },
          signal,
        )
        registered += 1
      }
      return { method: 'register_assets', registered }
    }
    case 'unregister_assets': {
      const projectId = required(input.projectId, 'projectId', input.method)
      const plan = requireDesignPlan(
        required(input.planId, 'planId', input.method),
        projectId,
      )
      const paths = required(input.paths, 'paths', input.method).map(
        assertSafeDesignPath,
      )
      const outside = paths.filter(
        filePath => !pathAllowedByPlan(filePath, plan.deletes),
      )
      if (outside.length > 0) {
        throw new Error(
          `Cannot unregister cards for paths outside the finalized plan's deletes: ${outside.join(', ')}. Re-run finalize_plan with the full set.`,
        )
      }
      let unregistered = 0
      for (const filePath of paths) {
        if (signal.aborted) throw signal.reason
        await deleteDesignAsset(token, projectId, filePath, signal)
        unregistered += 1
      }
      return { method: 'unregister_assets', unregistered }
    }
    case 'create_project': {
      const name = required(input.name, 'name', input.method)
      const project = await createDesignSystemProject(token, name, signal)
      return { method: 'create_project', ...project }
    }
    case 'report_validate':
      return { method: 'report_validate' }
  }
}

export const DesignSyncTool = buildTool({
  name: 'DesignSync',
  searchHint: 'sync local design system components to a claude.ai/design project',
  shouldDefer: true,
  maxResultSizeChars: 300_000,
  isEnabled() {
    return designGateFailure() === null
  },
  get inputSchema() {
    return designSyncInputSchema()
  },
  get outputSchema() {
    return designSyncOutputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input) {
    return isReadMethod(input.method)
  },
  isDestructive(input) {
    return (
      input.method === 'write_files' ||
      input.method === 'delete_files' ||
      input.method === 'unregister_assets'
    )
  },
  async description() {
    return DESIGN_SYNC_PROMPT
  },
  async prompt() {
    return DESIGN_SYNC_PROMPT
  },
  userFacingName(input) {
    return `Design: ${operationLabel(input)}`
  },
  getToolUseSummary(input) {
    return input?.method ? operationLabel(input) : null
  },
  toAutoClassifierInput(input) {
    if (input.method === 'finalize_plan') {
      return `project ${input.projectId ?? '?'} from ${path.resolve(input.localDir ?? '.')}: write ${(input.writes ?? []).join(', ')}; delete ${(input.deletes ?? []).join(', ')}`
    }
    if (input.method === 'create_project') {
      return `create project "${input.name ?? '?'}"`
    }
    return input.method
  },
  renderToolUseMessage(input) {
    return operationLabel(input)
  },
  async validateInput(input): Promise<ValidationResult> {
    const missing = missingDesignSyncFields(input)
    if (missing.length > 0) {
      return {
        result: false,
        message: `${input.method} requires: ${missing.join(', ')}.`,
        errorCode: 1,
      }
    }
    if (
      input.method === 'finalize_plan' &&
      (input.writes?.length ?? 0) === 0 &&
      (input.deletes?.length ?? 0) === 0
    ) {
      return {
        result: false,
        message: 'finalize_plan needs at least one write or delete path.',
        errorCode: 1,
      }
    }
    if (input.method === 'write_files') {
      for (const file of input.files ?? []) {
        const data = file.data !== undefined
        const local = file.localPath !== undefined
        if (data === local) {
          return {
            result: false,
            message: `Each file needs exactly one of "data" or "localPath" (offending path: ${file.path}).`,
            errorCode: 1,
          }
        }
        if (local && file.encoding !== undefined) {
          return {
            result: false,
            message: `"encoding" only applies to inline "data"; localPath files are encoded automatically (offending path: ${file.path}).`,
            errorCode: 1,
          }
        }
      }
    }
    return { result: true }
  },
  async checkPermissions(input, context) {
    let consentRequired = false
    const auth = await resolveDesignAccessToken(context.abortController.signal)
    if (auth.ok) {
      try {
        consentRequired =
          (await readDesignConsent(auth.accessToken, context.abortController.signal)) ===
          false
      } catch {
        // The server's canonical 403 body remains authoritative if preflight
        // is unavailable.
      }
    }
    const updatedInput = {
      ...input,
      ...(consentRequired
        ? { __consentBitShown: DESIGN_CONSENT_BIT }
        : {}),
      __consentAskCanReachUser: consentApprovalCanReachUser(context),
    } as DesignSyncInput
    const consentMessage = consentRequired
      ? 'Connect to Claude Design? Claude can read and edit your Design projects from this tool. Change anytime at claude.ai/design/settings or with /design revoke.'
      : null
    if (input.method === 'finalize_plan') {
      let localDir: string
      try {
        localDir = await realpath(path.resolve(input.localDir ?? '.'))
      } catch (error) {
        return {
          behavior: 'deny',
          message: `localDir does not exist or is not accessible: ${input.localDir ?? process.cwd()} (${error instanceof Error ? error.message : 'unknown error'})`,
          decisionReason: {
            type: 'safetyCheck',
            reason: 'localDir not found',
            classifierApprovable: false,
          },
        }
      }
      return {
        behavior: 'ask',
        message: [
          consentMessage,
          `To project: ${input.projectId ?? '?'}`,
          `From folder: ${localDir}`,
          `Upload ${(input.writes ?? []).join(', ') || '(none)'}`,
          `Delete ${(input.deletes ?? []).join(', ') || '(none)'}`,
        ]
          .filter(Boolean)
          .join('\n'),
        updatedInput: { ...updatedInput, localDir },
        decisionReason: {
          type: 'safetyCheck',
          reason: consentRequired
            ? 'Approving also grants Claude ongoing write access to your design projects.'
            : 'Review what will be uploaded before continuing.',
          classifierApprovable: false,
        },
      }
    }
    if (input.method === 'create_project') {
      return {
        behavior: 'ask',
        message: [
          consentMessage,
          `Create design-system project "${input.name ?? '?'}" on claude.ai/design. The new project will be visible to your whole org (server default — you can change this from the Share menu after creation).`,
        ]
          .filter(Boolean)
          .join('\n'),
        updatedInput,
        decisionReason: {
          type: 'safetyCheck',
          reason: consentRequired
            ? 'Approving also grants Claude ongoing write access to your design projects.'
            : 'This creates a new project on your claude.ai account.',
          classifierApprovable: false,
        },
      }
    }
    if (consentMessage && input.method !== 'report_validate') {
      return {
        behavior: 'ask',
        message: consentMessage,
        updatedInput,
        decisionReason: {
          type: 'safetyCheck',
          reason:
            'design agent consent — approving records a server-side grant for Claude agents to write your design projects',
          classifierApprovable: false,
        },
      }
    }
    return { behavior: 'allow', updatedInput }
  },
  async call(input, context) {
    if (input.method === 'report_validate') {
      return { data: { method: 'report_validate' } as DesignSyncOutput }
    }
    const auth = await resolveDesignAccessToken(context.abortController.signal)
    if (!auth.ok) {
      throw new DesignSyncPreconditionError(
        describeDesignAuthFailure(auth, context.options.isNonInteractiveSession),
      )
    }
    const internal = input as InternalDesignSyncInput
    const promptCanReachUser =
      internal.__consentAskCanReachUser === true &&
      consentApprovalCanReachUser(context)
    let consentRetried = false
    const execute = async (): Promise<DesignSyncOutput> => {
      try {
        return await executeDesignSync(
          input,
          auth.accessToken,
          context.abortController.signal,
        )
      } catch (error) {
        const body =
          error instanceof DesignHTTPError || error instanceof DesignRpcError
            ? error.body
            : undefined
        const consent =
          error instanceof DesignHTTPError &&
          error.status === 403 &&
          body &&
          typeof body === 'object' &&
          (body as Record<string, unknown>).error === 'needs_consent' &&
          (body as Record<string, unknown>).consent === DESIGN_CONSENT_BIT
            ? DESIGN_CONSENT_BIT
            : null
        if (
          consent === DESIGN_CONSENT_BIT &&
          internal.__consentBitShown === DESIGN_CONSENT_BIT &&
          promptCanReachUser &&
          !consentRetried
        ) {
          consentRetried = true
          await grantDesignConsent(
            auth.accessToken,
            context.abortController.signal,
          )
          return execute()
        }
        throw error
      }
    }
    try {
      if (
        input.method === 'finalize_plan' &&
        internal.__consentBitShown === DESIGN_CONSENT_BIT &&
        promptCanReachUser
      ) {
        await grantDesignConsent(
          auth.accessToken,
          context.abortController.signal,
        ).catch(() => {})
      }
      return {
        data: await execute(),
      }
    } catch (error) {
      const body =
        error instanceof DesignHTTPError || error instanceof DesignRpcError
          ? error.body
          : undefined
      if (
        error instanceof DesignHTTPError &&
        error.status === 403 &&
        body &&
        typeof body === 'object' &&
        (body as Record<string, unknown>).error === 'needs_consent' &&
        (body as Record<string, unknown>).consent === DESIGN_CONSENT_BIT
      ) {
        throw new DesignSyncPreconditionError(
          internal.__consentBitShown === DESIGN_CONSENT_BIT &&
            !promptCanReachUser
            ? "Connect to Claude Design? Claude can read and edit your Design projects from this tool. The user hasn't granted this — run /design consent to grant it (it can't be approved automatically in this permission mode)."
            : "Connect to Claude Design? Claude can read and edit your Design projects from this tool. The user hasn't granted this yet — ask them to retry (the prompt will show on the next call) or run /design consent.",
        )
      }
      if (
        error instanceof DesignHTTPError &&
        (error.status === 401 ||
          (body &&
            typeof body === 'object' &&
            (body as Record<string, unknown>).error === 'insufficient_scope'))
      ) {
        throw new DesignSyncPreconditionError(
          describeDesignAuthFailure(
            { ok: false, reason: 'needs_design_login' },
            context.options.isNonInteractiveSession,
          ),
        )
      }
      if (context.abortController.signal.aborted) {
        throw context.abortController.signal.reason
      }
      if (error instanceof Error && auth.accessToken) {
        error.message = error.message
          .split(auth.accessToken)
          .join('[redacted-oauth-token]')
      }
      throw error
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output),
    }
  },
} satisfies ToolDef<ReturnType<typeof designSyncInputSchema>, DesignSyncOutput>)
