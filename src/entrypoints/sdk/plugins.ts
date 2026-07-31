import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import { installPluginsForHeadless } from '../../utils/plugins/headlessPluginInstall.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import { updatePluginsForMarketplaces } from '../../utils/plugins/pluginAutoupdate.js'
import { resolve } from 'node:path'
import {
  loadKnownMarketplacesConfig,
  refreshMarketplace,
} from '../../utils/plugins/marketplaceManager.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import type { MarketplaceSource } from '../../utils/plugins/schemas.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import type { SdkPluginConfig } from './coreTypes.generated.js'
import {
  getInlinePlugins,
  setInlinePlugins,
} from '../../bootstrap/state.js'

export type SDKPluginMarketplaceSource = MarketplaceSource

export type SDKPluginMarketplaceIntent = {
  source: SDKPluginMarketplaceSource
  installLocation?: string
  autoUpdate?: boolean
  /**
   * Host-owned content revision for this marketplace. It is deliberately not
   * written to OpenClaude settings: it only tells the SDK when an already
   * materialized source must be refreshed between turns.
   */
  revision?: string
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
  /**
   * Complete session-local plugin roots, using the same native loader as
   * repeated `--plugin-dir` CLI flags. Inline plugins override an installed
   * plugin with the same name unless managed policy locks that plugin.
   */
  inlinePluginPaths?: string[]
  /**
   * Opaque host content revision for inline plugin roots. A changed revision
   * invalidates native plugin/command/skill/MCP caches without making the SDK
   * interpret host filesystem contents.
   */
  inlinePluginRevision?: string
}

/**
 * Apply the official Agent SDK local-plugin option to OpenClaude's existing
 * native inline-plugin loader. This deliberately performs no marketplace
 * refresh, installation, or manifest interpretation: the supplied paths are
 * already-materialized plugin roots and the native loader owns discovery.
 */
export function applySDKLocalPlugins(
  plugins: readonly SdkPluginConfig[] | undefined,
): { paths: string[]; changed: boolean } {
  if (plugins === undefined) {
    return { paths: [...getInlinePlugins()], changed: false }
  }

  const paths = [...new Set(plugins.map((plugin, index) => {
    if (!plugin || plugin.type !== 'local') {
      throw new Error(`plugins[${index}] must have type "local"`)
    }
    const pluginPath = plugin.path?.trim()
    if (!pluginPath) {
      throw new Error(`plugins[${index}].path must be non-empty`)
    }
    return resolve(pluginPath)
  }))].sort((left, right) => left.localeCompare(right))

  const current = [...new Set(getInlinePlugins().map(pluginPath =>
    resolve(pluginPath),
  ))].sort((left, right) => left.localeCompare(right))
  const changed = stableJSON(current) !== stableJSON(paths)
  if (changed) {
    setInlinePlugins(paths)
    clearAllCaches()
  }
  return { paths, changed }
}

export type SDKPluginProjection = {
  /** OpenClaude-resolved plugin name. */
  name: string
  /** Marketplace/source that supplied the enabled plugin. */
  source: string
  /** OpenClaude's resolved plugin root. */
  pluginRoot: string
  /** Exact enabled skill roots resolved by the native plugin loader. */
  skillRoots: string[]
}

/** @deprecated Use SDKPluginProjection. */
export type SDKPluginSkillProjection = SDKPluginProjection

export type SDKPluginPreparationResult = {
  changed: boolean
  revision?: string
  enabledPluginCount: number
  disabledPluginCount: number
  errorCount: number
  /** All enabled plugin roots resolved by the native OpenClaude loader. */
  pluginProjection: SDKPluginProjection[]
  /**
   * Read-only filesystem projection of the enabled plugin skills already
   * resolved by OpenClaude. Hosts may mirror these paths for a remote runtime,
   * but must not reinterpret plugin manifests or enablement.
   */
  pluginSkillProjection: SDKPluginProjection[]
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

export function pluginProjectionFromLoadedPlugins(
  plugins: readonly LoadedPlugin[],
): SDKPluginProjection[] {
  return plugins
    .map(plugin => ({
      name: plugin.name,
      source: plugin.source,
      pluginRoot: plugin.path,
      skillRoots: [...new Set(
        [plugin.skillsPath, ...(plugin.skillsPaths ?? [])]
          .filter((value): value is string => Boolean(value?.trim()))
          .map(value => value.trim()),
      )].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) =>
      left.name.localeCompare(right.name) ||
      left.source.localeCompare(right.source) ||
      left.pluginRoot.localeCompare(right.pluginRoot),
    )
}

export function pluginSkillProjectionFromLoadedPlugins(
  plugins: readonly LoadedPlugin[],
): SDKPluginProjection[] {
  return pluginProjectionFromLoadedPlugins(plugins)
    .filter(plugin => plugin.skillRoots.length > 0)
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
    if (marketplace.revision !== undefined && !marketplace.revision.trim()) {
      throw new Error(
        `plugin runtime marketplace ${JSON.stringify(name)} revision must be non-empty`,
      )
    }
  }
  for (const [index, pluginPath] of (intent.inlinePluginPaths ?? []).entries()) {
    if (typeof pluginPath !== 'string' || !pluginPath.trim()) {
      throw new Error(
        `plugin runtime inlinePluginPaths[${index}] must be a non-empty path`,
      )
    }
  }
  if (
    intent.inlinePluginRevision !== undefined &&
    !intent.inlinePluginRevision.trim()
  ) {
    throw new Error('plugin runtime inlinePluginRevision must be non-empty')
  }
}

function settingsMarketplaceIntent(
  marketplace: SDKPluginMarketplaceIntent,
): Omit<SDKPluginMarketplaceIntent, 'revision'> {
  const { revision: _revision, ...settingsIntent } = marketplace
  return settingsIntent
}

const preparedInlinePluginRevisions = new Map<string, string>()

function applyPluginRuntimeIntent(intent: SDKPluginRuntimeIntent): boolean {
  validatePluginRuntimeIntent(intent)
  const current = getSettingsForSource('userSettings') ?? {}
  const patch: SettingsJson = {}
  let changed = false
  let settingsChanged = false

  if (intent.enabledPlugins !== undefined) {
    const desired = sortedRecord(intent.enabledPlugins)
    if (stableJSON(current.enabledPlugins ?? {}) !== stableJSON(desired)) {
      patch.enabledPlugins = replacementPatch(
        current.enabledPlugins as Record<string, boolean> | undefined,
        desired,
      ) as SettingsJson['enabledPlugins']
      changed = true
      settingsChanged = true
    }
  }

  if (intent.marketplaces !== undefined) {
    const desired = sortedRecord(
      Object.fromEntries(
        Object.entries(intent.marketplaces).map(([name, marketplace]) => [
          name,
          settingsMarketplaceIntent(marketplace),
        ]),
      ),
    )
    if (stableJSON(current.extraKnownMarketplaces ?? {}) !== stableJSON(desired)) {
      patch.extraKnownMarketplaces = replacementPatch(
        current.extraKnownMarketplaces,
        desired,
      ) as SettingsJson['extraKnownMarketplaces']
      changed = true
      settingsChanged = true
    }
  }

  if (intent.inlinePluginPaths !== undefined) {
    const desired = [...new Set(intent.inlinePluginPaths.map(pluginPath =>
      resolve(pluginPath.trim()),
    ))].sort((left, right) => left.localeCompare(right))
    const currentInline = [...new Set(getInlinePlugins().map(pluginPath =>
      resolve(pluginPath),
    ))].sort((left, right) => left.localeCompare(right))
    if (stableJSON(currentInline) !== stableJSON(desired)) {
      setInlinePlugins(desired)
      changed = true
    }
    const stateKey = pluginRuntimeStateKey()
    const desiredRevision = intent.inlinePluginRevision ?? ''
    if (preparedInlinePluginRevisions.get(stateKey) !== desiredRevision) {
      preparedInlinePluginRevisions.set(stateKey, desiredRevision)
      changed = true
    }
  }

  if (settingsChanged) {
    const result = updateSettingsForSource('userSettings', patch)
    if (result.error) {
      throw result.error
    }
  }
  if (changed) {
    clearAllCaches()
  }
  return changed
}

const preparedMarketplaceRevisions = new Map<string, Record<string, string>>()

function pluginRuntimeStateKey(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || '<default>'
}

export function pluginRuntimeMarketplacesToRefresh(
  previousRevisions: Readonly<Record<string, string>>,
  materializedBeforePrepare: ReadonlySet<string>,
  marketplaces: Readonly<Record<string, SDKPluginMarketplaceIntent>>,
): string[] {
  const names: string[] = []
  for (const [name, marketplace] of Object.entries(marketplaces)) {
    const revision = marketplace.revision?.trim()
    if (!revision) continue
    const previous = previousRevisions[name]
    if (previous !== undefined) {
      if (previous !== revision) names.push(name)
      continue
    }
    // A missing marketplace will be cloned at its current revision by the
    // normal headless reconciler. Existing auto-update marketplaces need one
    // startup refresh because their cache may predate this SDK host process.
    if (marketplace.autoUpdate && materializedBeforePrepare.has(name)) {
      names.push(name)
    }
  }
  return names.sort((left, right) => left.localeCompare(right))
}

async function refreshPluginRuntimeMarketplaces(
  names: readonly string[],
): Promise<{ refreshed: Set<string>; errorCount: number }> {
  const refreshed = new Set<string>()
  let errorCount = 0
  for (const name of names) {
    try {
      await refreshMarketplace(name, undefined, {
        disableCredentialHelper: true,
      })
      refreshed.add(name.toLowerCase())
    } catch (error) {
      errorCount += 1
      logForDebugging(
        `SDK plugin runtime failed to refresh marketplace ${name}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  }
  if (refreshed.size > 0) {
    await updatePluginsForMarketplaces(refreshed)
    clearAllCaches()
  }
  return { refreshed, errorCount }
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
  const stateKey = pluginRuntimeStateKey()
  const previousRevisions = preparedMarketplaceRevisions.get(stateKey) ?? {}
  const materializedBeforePrepare = new Set(
    Object.keys(await loadKnownMarketplacesConfig()),
  )
  const intentChanged = intent ? applyPluginRuntimeIntent(intent) : false
  const marketplaceChanged = await installPluginsForHeadless()
  if (marketplaceChanged) {
    clearAllCaches()
  }

  const marketplaces = intent?.marketplaces ?? {}
  const refreshNames = pluginRuntimeMarketplacesToRefresh(
    previousRevisions,
    materializedBeforePrepare,
    marketplaces,
  )
  const refresh = await refreshPluginRuntimeMarketplaces(refreshNames)
  const nextRevisions: Record<string, string> = {}
  for (const [name, marketplace] of Object.entries(marketplaces)) {
    const revision = marketplace.revision?.trim()
    if (!revision) continue
    const refreshRequired = refreshNames.includes(name)
    if (!refreshRequired || refresh.refreshed.has(name.toLowerCase())) {
      nextRevisions[name] = revision
    } else if (previousRevisions[name] !== undefined) {
      // Keep the old revision so a transient refresh failure is retried on the
      // next turn instead of silently accepting stale plugin content.
      nextRevisions[name] = previousRevisions[name]!
    }
  }
  preparedMarketplaceRevisions.set(stateKey, nextRevisions)

  // The full loader is deliberately owned by OpenClaude. It resolves source
  // policy, installs/caches enabled bundles, and warms the cache-only readers
  // used by commands, skills, agents, hooks, LSP, and MCP. SDK hosts only
  // declare intent; they never reproduce plugin installation semantics.
  const loaded = await loadAllPlugins()
  const pluginProjection = pluginProjectionFromLoadedPlugins(loaded.enabled)
  return {
    changed:
      intentChanged || marketplaceChanged || refresh.refreshed.size > 0,
    ...(intent?.revision ? { revision: intent.revision } : {}),
    enabledPluginCount: loaded.enabled.length,
    disabledPluginCount: loaded.disabled.length,
    errorCount: loaded.errors.length + refresh.errorCount,
    pluginProjection,
    pluginSkillProjection: pluginProjection.filter(
      plugin => plugin.skillRoots.length > 0,
    ),
  }
}
