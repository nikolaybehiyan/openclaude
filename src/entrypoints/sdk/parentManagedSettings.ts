/**
 * Claude Agent SDK compatibility for Claude Code 2.1.221's hidden
 * `--managed-settings <json>` contract.
 *
 * A spawning SDK parent may contribute policy, but it is never an
 * unrestricted settings source.  The upstream client validates it as managed
 * settings and keeps only restrictions before the policy resolver considers
 * it.  A real administrator tier wins by default; it may opt in to layering
 * this filtered parent tier with `parentSettingsBehavior: "merge"`.
 */

import {
  getParentManagedSettings,
  setParentManagedSettings,
} from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { safeParseJSON } from '../../utils/json.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import {
  filterInvalidPermissionRules,
  formatZodError,
  type ValidationError,
} from '../../utils/settings/validation.js'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function copyKeys(
  source: UnknownRecord,
  keys: readonly string[],
): UnknownRecord {
  const result: UnknownRecord = {}
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key]
  }
  return result
}

/** Parse the hidden CLI flag exactly like Claude Code 2.1.221. */
export function loadParentManagedSettingsFromFlag(value: string): void {
  const parsed = safeParseJSON(value.trim(), false)
  if (!isRecord(parsed)) {
    logForDebugging('--managed-settings ignored: invalid JSON object', {
      level: 'warn',
    })
    return
  }
  setParentManagedSettings(parsed)
}

export function validateParentManagedSettings(): {
  present: boolean
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const stored = getParentManagedSettings()
  if (!stored || Object.keys(stored).length === 0) {
    return { present: false, settings: null, errors: [] }
  }

  // Permission-rule validation deliberately filters invalid entries. Keep the
  // authoritative parent snapshot immutable for subsequent cache rebuilds.
  const raw = structuredClone(stored)

  const managedWarnings: ValidationError[] = []
  if (
    'availableModels' in raw &&
    (!Array.isArray(raw.availableModels) ||
      raw.availableModels.some(value => typeof value !== 'string'))
  ) {
    raw.availableModels = []
    managedWarnings.push({
      file: 'parent managed settings',
      path: 'availableModels',
      message:
        '"availableModels" was present but invalid; enforcing an empty allowlist (only the default model is available) until it is fixed.',
    })
  }
  if (
    'forceLoginOrgUUID' in raw &&
    !(
      (typeof raw.forceLoginOrgUUID === 'string' &&
        raw.forceLoginOrgUUID.length > 0) ||
      (Array.isArray(raw.forceLoginOrgUUID) &&
        raw.forceLoginOrgUUID.every(
          value => typeof value === 'string' && value.length > 0,
        ))
    )
  ) {
    raw.forceLoginOrgUUID = []
    managedWarnings.push({
      file: 'parent managed settings',
      path: 'forceLoginOrgUUID',
      message:
        '"forceLoginOrgUUID" was present but invalid; no organization is permitted to log in until it is fixed.',
    })
  }

  const ruleWarnings = filterInvalidPermissionRules(
    raw,
    'parent managed settings',
  )
  const parsed = SettingsSchema().safeParse(raw)
  if (!parsed.success) {
    return {
      present: true,
      settings: null,
      errors: [
        ...managedWarnings,
        ...ruleWarnings,
        ...formatZodError(parsed.error, 'parent managed settings'),
      ],
    }
  }
  return {
    present: true,
    settings: parsed.data,
    errors: [...managedWarnings, ...ruleWarnings],
  }
}

/**
 * Whether the parent tier participates in policy resolution.
 * No admin tier: yes. Admin tier: only when it explicitly opts into merge.
 */
export function shouldMergeParentManagedSettings(
  adminSettings: SettingsJson | null,
): boolean {
  return (
    adminSettings === null || adminSettings.parentSettingsBehavior === 'merge'
  )
}

/** Aggregate the administrator-owned dimensions used to constrain a parent. */
export function buildParentManagedSettingsGuard(
  adminTiers: SettingsJson[],
): SettingsJson {
  const primaryAdmin = adminTiers[0]
  return {
    allowManagedPermissionRulesOnly:
      adminTiers.some(
        tier => tier.allowManagedPermissionRulesOnly === true,
      ) || undefined,
    forceLoginOrgUUID: adminTiers.find(
      tier => tier.forceLoginOrgUUID !== undefined,
    )?.forceLoginOrgUUID,
    allowedMcpServers: adminTiers.find(
      tier => tier.allowedMcpServers !== undefined,
    )?.allowedMcpServers,
    availableModels: primaryAdmin?.availableModels,
    allow_design_sync: adminTiers.find(
      tier => tier.allow_design_sync !== undefined,
    )?.allow_design_sync,
    sandbox: {
      network: {
        allowManagedDomainsOnly:
          adminTiers.some(
            tier =>
              tier.sandbox?.network?.allowManagedDomainsOnly === true,
          ) || undefined,
      },
      filesystem: {
        allowManagedReadPathsOnly:
          adminTiers.some(
            tier =>
              tier.sandbox?.filesystem?.allowManagedReadPathsOnly === true,
          ) || undefined,
      },
    },
  }
}

/**
 * Keep the restrictive-only subset used by Claude Code 2.1.221.  Values that
 * grant capability are admitted only where a stronger admin lock has not
 * claimed that dimension, matching the upstream parent-tier algorithm.
 */
export function restrictParentManagedSettings(
  parentSettings: SettingsJson,
  adminSettings: SettingsJson | null,
): SettingsJson | null {
  const parent = parentSettings as UnknownRecord
  const admin = (adminSettings ?? {}) as UnknownRecord
  const result: UnknownRecord = {}

  for (const key of [
    'allowManagedHooksOnly',
    'allowManagedMcpServersOnly',
    'disableClaudeAiConnectors',
    'allowManagedPermissionRulesOnly',
  ] as const) {
    if (parent[key] === true) result[key] = true
  }

  const strictPluginOnlyCustomization =
    parent.strictPluginOnlyCustomization
  if (
    strictPluginOnlyCustomization === true ||
    (Array.isArray(strictPluginOnlyCustomization) &&
      strictPluginOnlyCustomization.length > 0)
  ) {
    result.strictPluginOnlyCustomization = strictPluginOnlyCustomization
  }

  if (parent.deniedMcpServers !== undefined) {
    result.deniedMcpServers = parent.deniedMcpServers
  }
  if (
    admin.forceLoginOrgUUID === undefined &&
    parent.forceLoginOrgUUID !== undefined
  ) {
    result.forceLoginOrgUUID = parent.forceLoginOrgUUID
  }
  if (
    admin.allowedMcpServers === undefined &&
    parent.allowedMcpServers !== undefined
  ) {
    result.allowedMcpServers = parent.allowedMcpServers
  }
  if (
    admin.availableModels === undefined &&
    parent.availableModels !== undefined
  ) {
    result.availableModels = parent.availableModels
  }
  if (parent.enforceAvailableModels === true) {
    result.enforceAvailableModels = true
  }
  if (
    admin.allow_design_sync === undefined &&
    typeof parent.allow_design_sync === 'boolean'
  ) {
    result.allow_design_sync = parent.allow_design_sync
  }

  const parentPermissions = asRecord(parent.permissions)
  const permissions = copyKeys(parentPermissions, ['deny', 'ask'])
  if (parentPermissions.disableBypassPermissionsMode === 'disable') {
    permissions.disableBypassPermissionsMode = 'disable'
  }

  const adminSandbox = asRecord(admin.sandbox)
  const adminNetwork = asRecord(adminSandbox.network)
  if (admin.allowManagedPermissionRulesOnly !== true) {
    if (
      parentPermissions.allow !== undefined &&
      adminNetwork.allowManagedDomainsOnly !== true
    ) {
      permissions.allow = parentPermissions.allow
    }
    if (parentPermissions.additionalDirectories !== undefined) {
      permissions.additionalDirectories =
        parentPermissions.additionalDirectories
    }
  }
  if (Object.keys(permissions).length > 0) result.permissions = permissions

  const parentSandbox = asRecord(parent.sandbox)
  const sandbox: UnknownRecord = {}
  if (parentSandbox.enabled === true) sandbox.enabled = true
  if (parentSandbox.failIfUnavailable === true) {
    sandbox.failIfUnavailable = true
  }
  if (parentSandbox.allowUnsandboxedCommands === false) {
    sandbox.allowUnsandboxedCommands = false
  }
  if (parentSandbox.autoAllowBashIfSandboxed === false) {
    sandbox.autoAllowBashIfSandboxed = false
  }

  const parentNetwork = asRecord(parentSandbox.network)
  const network = copyKeys(parentNetwork, ['deniedDomains'])
  if (parentNetwork.allowManagedDomainsOnly === true) {
    network.allowManagedDomainsOnly = true
  }
  if (parentNetwork.strictAllowlist === true) network.strictAllowlist = true
  if (
    adminNetwork.allowManagedDomainsOnly !== true &&
    parentNetwork.allowedDomains !== undefined
  ) {
    network.allowedDomains = parentNetwork.allowedDomains
  }
  if (Object.keys(network).length > 0) sandbox.network = network

  const parentFilesystem = asRecord(parentSandbox.filesystem)
  const adminFilesystem = asRecord(adminSandbox.filesystem)
  const filesystem = copyKeys(parentFilesystem, ['denyRead', 'denyWrite'])
  if (parentFilesystem.allowManagedReadPathsOnly === true) {
    filesystem.allowManagedReadPathsOnly = true
  }
  if (parentFilesystem.disabled === false) filesystem.disabled = false
  if (
    adminFilesystem.allowManagedReadPathsOnly !== true &&
    parentFilesystem.allowRead !== undefined
  ) {
    filesystem.allowRead = parentFilesystem.allowRead
  }
  if (Object.keys(filesystem).length > 0) sandbox.filesystem = filesystem

  const parentCredentials = asRecord(parentSandbox.credentials)
  const credentialFiles = Array.isArray(parentCredentials.files)
    ? parentCredentials.files.flatMap(value => {
        const file = asRecord(value)
        if (typeof file.path !== 'string') return []
        return [
          file.mode === 'deny'
            ? { path: file.path, mode: 'deny' }
            : { path: file.path, mode: 'mask', injectHosts: [] },
        ]
      })
    : []
  const credentialEnvVars = Array.isArray(parentCredentials.envVars)
    ? parentCredentials.envVars.flatMap(value => {
        const envVar = asRecord(value)
        return envVar.mode === 'deny' && typeof envVar.name === 'string'
          ? [{ name: envVar.name, mode: 'deny' }]
          : []
      })
    : []
  const credentials: UnknownRecord = {}
  if (credentialFiles.length > 0) credentials.files = credentialFiles
  if (credentialEnvVars.length > 0) credentials.envVars = credentialEnvVars
  if (parentCredentials.allowPlaintextInject === false) {
    credentials.allowPlaintextInject = false
  }
  if (Object.keys(credentials).length > 0) sandbox.credentials = credentials

  if (Object.keys(sandbox).length > 0) result.sandbox = sandbox
  if (Object.keys(result).length === 0) return null

  const parsed = SettingsSchema().safeParse(result)
  return parsed.success ? parsed.data : null
}
