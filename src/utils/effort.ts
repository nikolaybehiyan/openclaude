// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { isProSubscriber, isMaxSubscriber, isTeamSubscriber } from './auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getAPIProvider } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { supportsCodexReasoningEffort } from '../services/api/providerConfig.js'
import { isEnvTruthy } from './envUtils.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'
import { currentDarbCustomCatalog, darbSelectedThinking, isDarbCustomInference } from './model/darbModels.js'
import { darbCanSelectEffort, darbEffortOptions, isDarbEffort } from './model/darbModelControls.js'
import { getDarbNativeParameters } from './model/darbFrozenContext.js'

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

export const OPENAI_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const

export type OpenAIEffortLevel = typeof OPENAI_EFFORT_LEVELS[number]
export type EffortValue = EffortLevel | number
export type PersistedEffortLevel = Exclude<EffortLevel, 'max'>

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  const native = getDarbNativeParameters(model)
  if (native) return native.effort_values.length > 0
  if (isDarbCustomInference()) {
    const row = currentDarbCustomCatalog()?.models.find(row => row.id === model)
    return !!row && row.reasoning_support !== 'unsupported' && row.effort_support !== 'unsupported' &&
      (darbEffortOptions(row).length > 0 || row.parameter_contract?.effort.support !== undefined && row.parameter_contract.effort.support !== 'unsupported')
  }
  const m = model.toLowerCase()
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (modelUsesOpenAIEffort(model) && supportsCodexReasoningEffort(model)) {
    return true
  }
  // Supported by a subset of Claude 4 models
  if (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    m.includes('opus-4-7') ||
    m.includes('opus-4-8') ||
    m.includes('sonnet-5') ||
    m.includes('opus-5') ||
    m.includes('fable-5')
  ) {
    return true
  }
  // Exclude any other known legacy models (haiku, older opus/sonnet variants)
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // Default to true for unknown model strings on 1P.
  // Do not default to true for 3P as they have different formats for their
  // model strings (ex. anthropics/claude-code#30795)
  return getAPIProvider() === 'firstParty'
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'max' effort.
// Per API docs, 'max' is Opus 4.6 only for public models — other models return an error.
export function modelSupportsMaxEffort(model: string): boolean {
  const native = getDarbNativeParameters(model)
  if (native) return native.effort_values.includes('max')
  if (isDarbCustomInference()) return getAvailableEffortLevels(model).some(level => level === 'max')
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const m = model.toLowerCase()
  if (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    m.includes('opus-4-7') ||
    m.includes('opus-4-8') ||
    m.includes('sonnet-5') ||
    m.includes('opus-5') ||
    m.includes('fable-5')
  ) {
    return true
  }
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)) {
    return true
  }
  return false
}

// @[MODEL LAUNCH]: Add models that support the xhigh tier. Third-party model
// aliases (including Desktop's pinned provider models) carry the authoritative
// xhigh_effort capability in their environment projection.
export function modelSupportsXHighEffort(model: string): boolean {
  const native = getDarbNativeParameters(model)
  if (native) return native.effort_values.includes('xhigh')
  if (isDarbCustomInference()) return getAvailableEffortLevels(model).includes('xhigh')
  const supported3P = get3PModelCapabilityOverride(model, 'xhigh_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-7') ||
    m.includes('opus-4-8') ||
    m.includes('sonnet-5') ||
    m.includes('opus-5') ||
    m.includes('fable-5')
  )
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function isOpenAIEffortLevel(value: string): value is OpenAIEffortLevel {
  return (OPENAI_EFFORT_LEVELS as readonly string[]).includes(value)
}

export function modelUsesOpenAIEffort(model: string): boolean {
  const provider = getAPIProvider()
  return provider === 'openai' || provider === 'codex'
}

export function getAvailableEffortLevels(model: string): EffortLevel[] | OpenAIEffortLevel[] {
  const native = getDarbNativeParameters(model)
  if (native) return [...native.effort_values]
  if (isDarbCustomInference()) {
    const row = currentDarbCustomCatalog()?.models.find(row => row.id === model)
    // The native UI typedef is a closed Claude enum; managed values are
    // validated owner data and must not be filtered through that enum.
    return (row ? [...darbEffortOptions(row)] : []) as EffortLevel[]
  }
  if (!modelSupportsEffort(model)) {
    return []
  }
  if (modelUsesOpenAIEffort(model)) {
    return [...OPENAI_EFFORT_LEVELS] as OpenAIEffortLevel[]
  }
  const levels: EffortLevel[] = ['low', 'medium', 'high']
  if (modelSupportsXHighEffort(model)) {
    levels.push('xhigh')
  }
  if (modelSupportsMaxEffort(model)) {
    levels.push('max')
  }
  return levels
}

export function getEffortLevelLabel(level: EffortLevel | OpenAIEffortLevel): string {
  if (level === 'xhigh') return 'Extra High'
  if (level === 'max') return 'Max'
  return capitalize(level)
}

export function openAIEffortToStandard(level: OpenAIEffortLevel): EffortLevel {
  return level
}

export function standardEffortToOpenAI(level: EffortLevel): OpenAIEffortLevel {
  if (level === 'max') return 'xhigh'
  return level as OpenAIEffortLevel
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (isDarbCustomInference()) {
    if (!isDarbEffort(value)) throw new Error('Invalid explicit Darb effort value')
    return value as EffortValue
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values and 'max' are session-only and are not persisted.
 * Claude Code 2.1.221 persists low/medium/high/xhigh in settings.json.
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): PersistedEffortLevel | undefined {
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): PersistedEffortLevel | undefined {
  if (isDarbCustomInference()) return undefined // Never inherit another model's global Claude preference.
  // toPersistableEffort validates persisted levels on read, so a manually
  // edited settings.json with an invalid level doesn't leak into a fresh session.
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  if (isDarbCustomInference() && envOverride !== undefined) {
    if (envOverride === 'unset' || envOverride === 'auto') return null
    if (!isDarbEffort(envOverride)) throw new Error('Invalid explicit Darb effort value')
    return envOverride as EffortValue
  }
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env CLAUDE_CODE_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  inheritManagedSelection = true,
): EffortValue | undefined {
  const envOverride = isDarbCustomInference() && !inheritManagedSelection ? undefined : getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const native = getDarbNativeParameters(model)
  if (native) {
    const requested = envOverride ?? appStateEffortValue
    if (requested === undefined) return undefined // Keep the provider's own default.
    if (typeof requested !== 'string' || !native.effort_values.includes(requested as EffortLevel)) {
      throw new Error('Darb selected effort is unavailable; no fallback effort was used')
    }
    return requested
  }
  if (isDarbCustomInference()) {
    const resolved = envOverride ?? appStateEffortValue ?? (inheritManagedSelection ? darbSelectedThinking(model)?.effort : undefined)
    if (resolved === undefined) return undefined
    const row = currentDarbCustomCatalog()?.models.find(row => row.id === model)
    if (typeof resolved !== 'string' || !row || !darbCanSelectEffort(row, resolved)) throw new Error('Darb selected effort is unavailable; no fallback effort was used')
    return resolved as EffortValue
  }
  const resolved =
    envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  // Unsupported requested levels fall back to the highest supported level at
  // or below the request, matching Claude Code 2.1.221.
  if (
    resolved === 'xhigh' &&
    !modelSupportsXHighEffort(model) &&
    !modelUsesOpenAIEffort(model)
  ) {
    return 'high'
  }
  if (
    resolved === 'max' &&
    !modelSupportsMaxEffort(model) &&
    !modelUsesOpenAIEffort(model)
  ) {
    return modelSupportsXHighEffort(model) ? 'xhigh' : 'high'
  }
  return resolved
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  if (isDarbCustomInference()) {
    // Status text must not crash the TUI while a strict save/refresh revokes
    // the catalog. Request-time resolveAppliedEffort remains fail-closed.
    try { return (resolveAppliedEffort(model, appStateEffort) ?? 'auto') as EffortLevel }
    catch { return 'unavailable' as EffortLevel }
  }
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    if (isDarbCustomInference() && isDarbEffort(value)) return value as EffortLevel
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  return 'high'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel | OpenAIEffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'max':
      return 'Maximum capability with deepest reasoning (this session only)'
    case 'xhigh':
      return 'Extra high reasoning effort for complex coding and agentic tasks'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[internal-only] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    if (isDarbCustomInference() && !isEffortLevel(value)) return `Provider effort value: ${value}`
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long Claude thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (getDarbNativeParameters(model)) return undefined
  if (isDarbCustomInference()) return darbSelectedThinking(model)?.effort as EffortValue | undefined
  if (process.env.USER_TYPE === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === config.defaultModel.toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // Always default ants to undefined/high
    return undefined
  }

  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  // Claude Code 2.1.221 defaults Opus 4.7 to xhigh. Newer model defaults are
  // projected by Desktop or remain the API default when no level is supplied.
  if (model.toLowerCase().includes('opus-4-7')) {
    return 'xhigh'
  }

  // Default effort on Opus 4.6 to medium for Pro.
  // Max/Team also get medium when the tengu_grey_step2 config is enabled.
  if (model.toLowerCase().includes('opus-4-6')) {
    if (isProSubscriber()) {
      return 'medium'
    }
    if (
      getOpusDefaultEffortConfig().enabled &&
      (isMaxSubscriber() || isTeamSubscriber())
    ) {
      return 'medium'
    }
  }

  // When ultrathink feature is on, default effort to medium (ultrathink bumps to high)
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}
