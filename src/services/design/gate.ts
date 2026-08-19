import { isHostManagedExternalInference } from '../../constants/oauth.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { DESIGN_FEATURE_FLAG } from './constants.js'

export type DesignGateFailure =
  | 'disabled'
  | 'wrong_provider'
  | 'essential_traffic_only'

/**
 * 2.1.221's managed setting is fail-closed. Darbmind's host-managed external
 * inference keeps the owned OAuth/control plane first-party while the model
 * transport is provider-managed, so it is the only non-api.anthropic.com
 * adaptation accepted here.
 */
export function designGateFailure(): DesignGateFailure | null {
  const policy = getSettingsForSource('policySettings') as
    | ({ allow_design_sync?: boolean } & Record<string, unknown>)
    | null
  if (policy?.allow_design_sync !== true) return 'disabled'
  if (!getFeatureValue_CACHED_MAY_BE_STALE(DESIGN_FEATURE_FLAG, false)) {
    return 'disabled'
  }
  if (isEssentialTrafficOnly()) return 'essential_traffic_only'
  if (
    getAPIProvider() !== 'firstParty' &&
    !isHostManagedExternalInference()
  ) {
    return 'wrong_provider'
  }
  if (
    !isFirstPartyAnthropicBaseUrl() &&
    !isHostManagedExternalInference()
  ) {
    return 'wrong_provider'
  }
  return null
}
