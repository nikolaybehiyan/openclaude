import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import { installPluginsForHeadless } from '../../utils/plugins/headlessPluginInstall.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import type { MarketplaceSource } from '../../utils/plugins/schemas.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

export type SDKPluginMarketplaceSource = MarketplaceSource

export type SDKPluginMarketplaceIntent = {
  source: SDKPluginMarketplaceSource
  installLocation?: string
  autoUpdate?: boolean
}

export type SDKPluginRuntimeIntent = {
  /**
   * Opaque host revision used for diagnostics. OpenClaude still compares the
   * actual intent so a repeated revision can never hide a changed payload.
   */
  revision?: string
  /** Complete user-scope plugin enablement projection. */
  enabledPlugins?: Record<string, boolean>
  /** Complete user-scope marketplace declaration projection. */
  marketplaces?: Record<string, SDKPluginMarketplaceIntent>
}

export type SDKPluginPreparationResult = {
  changed: boolean
  revision?: string
  enabledPluginCount: number
  disabledPluginCount: number
  errorCount: number
}

function sortedRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJSON).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJSON(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function replacementPatch<T>(
  current: Record<string, T> | undefined,
  desired: Record<string, T>,
): Record<string, T | undefined> {
  const patch: Record<string, T | undefined> = { ...desired }
  for (const key of Object.keys(current ?? {})) {
    if (!(key in desired)) {
      patch[key] = undefined
    }
  }
  return patch
}

function validatePluginRuntimeIntent(intent: SDKPluginRuntimeIntent): void {
  if (intent.revision !== undefined && !intent.revision.trim()) {
    throw new Error('plugin runtime intent revision must be non-empty')
  }
  for (const [pluginId, enabled] of Object.entries(intent.enabledPlugins ?? {})) {
    const separator = pluginId.lastIndexOf('@')
    if (separator <= 0 || separator === pluginId.length - 1) {
      throw new Error(
        `plugin runtime intent key ${JSON.stringify(pluginId)} must use plugin@marketplace format`,
      )
    }
    if (typeof enabled !== 'boolean') {
      throw new Error(
        `plugin runtime intent value for ${JSON.stringify(pluginId)} must be boolean`,
      )
    }
  }
  for (const [name, marketplace] of Object.entries(intent.marketplaces ?? {})) {
    if (!name.trim()) {
      throw new Error('plugin runtime marketplace name must be non-empty')
    }
    if (!marketplace || typeof marketplace !== 'object' || !marketplace.source) {
      throw new Error(
        `plugin runtime marketplace ${JSON.stringify(name)} requires a source`,
      )
    }
  }
}

function applyPluginRuntimeIntent(intent: SDKPluginRuntimeIntent): boolean {
  validatePluginRuntimeIntent(intent)
  const current = getSettingsForSource('userSettings') ?? {}
  const patch: SettingsJson = {}
  let changed = false

  if (intent.enabledPlugins !== undefined) {
    const desired = sortedRecord(intent.enabledPlugins)
    if (stableJSON(current.enabledPlugins ?? {}) !== stableJSON(desired)) {
      patch.enabledPlugins = replacementPatch(
        current.enabledPlugins as Record<string, boolean> | undefined,
        desired,
      ) as SettingsJson['enabledPlugins']
      changed = true
    }
  }

  if (intent.marketplaces !== undefined) {
    const desired = sortedRecord(intent.marketplaces)
    if (stableJSON(current.extraKnownMarketplaces ?? {}) !== stableJSON(desired)) {
      patch.extraKnownMarketplaces = replacementPatch(
        current.extraKnownMarketplaces,
        desired,
      ) as SettingsJson['extraKnownMarketplaces']
      changed = true
    }
  }

  if (!changed) {
    return false
  }
  const result = updateSettingsForSource('userSettings', patch)
  if (result.error) {
    throw result.error
  }
  clearAllCaches()
  return true
}

/**
 * Reconcile marketplace seeds and enabled plugin bundles for an SDK host.
 *
 * The SDK itself stays cache-only while a turn is running. Hosts call this
 * between turns, after configuring CLAUDE_CONFIG_DIR and any read-only
 * CLAUDE_CODE_PLUGIN_SEED_DIR, so marketplace materialization never races a
 * model turn or replaces conversation history.
 */
export async function unstable_preparePluginRuntime(
  intent?: SDKPluginRuntimeIntent,
): Promise<SDKPluginPreparationResult> {
  const intentChanged = intent ? applyPluginRuntimeIntent(intent) : false
  const marketplaceChanged = await installPluginsForHeadless()
  if (marketplaceChanged) {
    clearAllCaches()
  }

  // The full loader is deliberately owned by OpenClaude. It resolves source
  // policy, installs/caches enabled bundles, and warms the cache-only readers
  // used by commands, skills, agents, hooks, LSP, and MCP. SDK hosts only
  // declare intent; they never reproduce plugin installation semantics.
  const loaded = await loadAllPlugins()
  return {
    changed: intentChanged || marketplaceChanged,
    ...(intent?.revision ? { revision: intent.revision } : {}),
    enabledPluginCount: loaded.enabled.length,
    disabledPluginCount: loaded.disabled.length,
    errorCount: loaded.errors.length,
  }
}
