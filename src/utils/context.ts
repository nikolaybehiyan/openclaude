// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { resolveModelRuntimeLimits } from '../integrations/runtimeMetadata.js'
import {
  getTransportKindForRoute,
  resolveActiveRouteIdFromEnv,
} from '../integrations/routeMetadata.js'
import { getCanonicalName } from './model/model.js'
import { getModelCapability } from './model/modelCapabilities.js'
import { getDarbFrozenModelContext } from './model/darbFrozenContext.js'
import { currentDarbCustomCatalog, isDarbCustomInference } from './model/darbModels.js'
import type { DarbModelBinding } from './model/darbCatalog.js'

type ManagedModelCapacity = Pick<DarbModelBinding, 'supports_1m' | 'context_window_tokens' | 'max_context_tokens' | 'max_input_tokens' | 'max_output_tokens'>
const UNKNOWN_MANAGED_CAPACITY: ManagedModelCapacity = Object.freeze({ supports_1m: false, context_window_tokens: 0 })

function managedModelContext(model: string): ManagedModelCapacity | undefined {
  const frozen = getDarbFrozenModelContext(model)
  if (frozen) return frozen
  if (!isDarbCustomInference()) return undefined
  // Budget readers also run while /model refresh clears the catalog, or a
  // saved selection is no longer available. They are not authorization checks:
  // keep the ordinary unknown-capacity budget so the TUI can recover instead
  // of crashing. Never reinterpret a stale ID as a Claude capability. Actual
  // inference/agent/selection entry points still requireDarbModel and fail closed.
  return currentDarbCustomCatalog()?.models.find(row => row.id === model) ?? UNKNOWN_MANAGED_CAPACITY
}

// Legacy internal budgeting fallback. This is not an assertion about the
// capacity of an unknown custom model; gateway capacity is separate metadata.
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

export function getKnownDarbModelContextCapacity(model: string): number | null {
  return managedModelContext(model)?.max_context_tokens ?? null
}

export function getKnownDarbModelInputCapacity(model: string): number | null {
  return managedModelContext(model)?.max_input_tokens ?? null
}

export function getKnownDarbModelOutputCapacity(model: string): number | null {
  return managedModelContext(model)?.max_output_tokens ?? null
}

// A total window and a separate input ceiling constrain different things.
// Consumers reserve their own output budget, then honor both known limits.
// null deliberately preserves their legacy fallback when neither is known.
export function getKnownDarbInputBudget(model: string, reservedOutput: number): number | null {
  const managed = managedModelContext(model)
  if (!managed || managed.max_context_tokens === undefined && managed.max_input_tokens === undefined) return null
  if (!Number.isSafeInteger(reservedOutput) || reservedOutput < 0) throw new Error('Invalid Darb output reservation')
  const available = Math.min(
    managed.max_input_tokens ?? Infinity,
    managed.max_context_tokens === undefined ? Infinity : managed.max_context_tokens - reservedOutput,
  )
  if (available <= 0) throw new Error('Darb output reservation leaves no input capacity; reduce the output token limit')
  return available
}

// Fallback context window for unknown 3P models. Must be large enough that
// the effective context (this minus output token reservation) stays positive,
// otherwise auto-compact fires on every message (issue #635).
// Override via CLAUDE_CODE_OPENAI_FALLBACK_CONTEXT_WINDOW env var to avoid
// hardcoding when deploying models not yet in integration model metadata.
export const OPENAI_FALLBACK_CONTEXT_WINDOW = (() => {
  const v = parseInt(process.env.CLAUDE_CODE_OPENAI_FALLBACK_CONTEXT_WINDOW ?? '', 10)
  return !isNaN(v) && v > 0 ? v : 128_000
})()

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  const managed = managedModelContext(model)
  if (managed) {
    if (managed.context_window_tokens === 1_000_000 && is1mContextDisabled()) {
      throw new Error('Darb selected 1M context is disabled by runtime policy')
    }
    return managed.context_window_tokens === 1_000_000
  }
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const managed = managedModelContext(model)
  if (managed) return managed.supports_1m
  const canonical = getCanonicalName(model)
  return canonical.includes('claude-sonnet-4') || canonical.includes('opus-4-6')
}

function shouldUseIntegrationRuntimeLimits(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const routeId = resolveActiveRouteIdFromEnv(processEnv)
  const transportKind = routeId ? getTransportKindForRoute(routeId) : null

  return (
    transportKind === 'openai-compatible' ||
    transportKind === 'local' ||
    transportKind === 'gemini-native'
  )
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  const managed = managedModelContext(model)
  if (managed) {
    if (managed.context_window_tokens === 1_000_000) {
      if (is1mContextDisabled()) throw new Error('Darb selected 1M context is disabled by runtime policy')
      return 1_000_000
    }
    // Zero is the standard variant, not a numeric capacity. Prefer the owner's
    // total context window; preserve the legacy input-capacity fallback when
    // no total is supplied, then the unchanged 200k default. Never infer either
    // numeric field from the opaque model ID or conflate total with input.
    const capacity = managed.max_context_tokens ?? managed.max_input_tokens
    if (capacity !== undefined && capacity >= 1_000_000 && is1mContextDisabled()) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return capacity ?? MODEL_CONTEXT_WINDOW_DEFAULT
  }
  // Allow override via environment variable (internal-only)
  // This takes precedence over all other context window resolution, including 1M detection,
  // so users can cap the effective context window for local decisions (auto-compact, etc.)
  // while still using a 1M-capable endpoint.
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  ) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mContext(model)) {
    return 1_000_000
  }

  // OpenAI-compatible provider — use known context windows for the model.
  // Unknown models get a conservative 128k default. This was previously 8k,
  // but that caused auto-compact to fire on every turn because the effective
  // context (8k minus output reservation) became negative (issue #635).
  if (shouldUseIntegrationRuntimeLimits()) {
    const runtimeLimits = resolveModelRuntimeLimits({ model })
    if (runtimeLimits.contextWindow !== undefined) {
      return runtimeLimits.contextWindow
    }
    console.error(
      `[context] Warning: model "${model}" not in integration model metadata — using conservative 128k default. ` +
      'Add it to src/integrations/models for accurate compaction.',
    )
    return OPENAI_FALLBACK_CONTEXT_WINDOW
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return antModel.contextWindow
    }
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  const managed = managedModelContext(model)
  if (managed) {
    // Owner-observed maximum, never a Claude-family or route-name guess. An
    // unknown model keeps separate legacy request budgets, not a claimed cap.
    const capacity = managed.max_output_tokens
    return {
      default: Math.min(MAX_OUTPUT_TOKENS_DEFAULT, capacity ?? MAX_OUTPUT_TOKENS_DEFAULT),
      upperLimit: capacity ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT,
    }
  }
  let defaultTokens: number
  let upperLimit: number

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  // OpenAI-compatible provider — use known output limits to avoid 400 errors
  if (shouldUseIntegrationRuntimeLimits()) {
    const runtimeLimits = resolveModelRuntimeLimits({ model })
    if (runtimeLimits.maxOutputTokens !== undefined) {
      return {
        default: runtimeLimits.maxOutputTokens,
        upperLimit: runtimeLimits.maxOutputTokens,
      }
    }
  }

  const m = getCanonicalName(model)

  if (m.includes('opus-4-6')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
