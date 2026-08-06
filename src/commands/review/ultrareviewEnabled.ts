import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

export const DEFAULT_ULTRAREVIEW_CONFIG: Readonly<Record<string, unknown>> =
  Object.freeze({ enabled: true })

export function getUltrareviewConfig(): Record<string, unknown> | null {
  return getFeatureValue_CACHED_MAY_BE_STALE<Record<string, unknown> | null>(
    'tengu_review_bughunter_config',
    DEFAULT_ULTRAREVIEW_CONFIG,
  )
}

export function isUltrareviewConfigEnabled(
  config: Record<string, unknown> | null,
): boolean {
  return config?.enabled === true
}

/**
 * Runtime gate for /ultrareview. GB config's `enabled` field controls
 * visibility — isEnabled() on the command filters it from getCommands()
 * when false, so ungated users don't see the command at all.
 */
export function isUltrareviewEnabled(): boolean {
  return isUltrareviewConfigEnabled(getUltrareviewConfig())
}
