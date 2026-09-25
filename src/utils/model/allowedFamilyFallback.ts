import { modelSupports1M } from '../context.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { isModelFamilyAlias } from './aliases.js'
import { CANONICAL_MODEL_IDS } from './configs.js'
import { getDarbFrozenModelContext } from './darbFrozenContext.js'
import { isDarbCustomInference } from './darbModels.js'
import { getModelDeprecationWarning } from './deprecation.js'
import { parseUserSpecifiedModel } from './model.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

/** Resolve a restricted family alias from the registered catalog, never from
 * environment alias overrides or arbitrary strings in an allowlist. */
export function getNewestAllowedModelInFamily(requested: string): string | null {
  if (getDarbFrozenModelContext() || isDarbCustomInference()) return null
  // Reference hF does not translate first-party fallback IDs to Bedrock,
  // Vertex or Foundry. Those providers retain their parent-model fallback.
  if (getAPIProvider() !== 'firstParty' || !isFirstPartyAnthropicBaseUrl()) return null
  if (!getSettings_DEPRECATED()?.availableModels) return null
  const normalized = requested.trim().toLowerCase()
  const family = normalized.replace(/\[1m\]$/, '').trim()
  if (!isModelFamilyAlias(family)) return null

  for (let index = CANONICAL_MODEL_IDS.length - 1; index >= 0; index--) {
    const candidate = CANONICAL_MODEL_IDS[index]!
    if (!candidate.split('-').includes(family)) continue
    if (getModelDeprecationWarning(candidate)) continue
    // A retired/remapped ID must not silently resolve outside the allowlist.
    if (parseUserSpecifiedModel(candidate) !== candidate) continue
    const extended = `${candidate}[1m]`
    if (normalized !== family && modelSupports1M(candidate) && isModelAllowed(extended)) return extended
    if (isModelAllowed(candidate)) return candidate
  }
  return null
}
