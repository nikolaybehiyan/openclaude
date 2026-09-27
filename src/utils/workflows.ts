import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isPolicyAllowed } from '../services/policyLimits/index.js'
import { getSubscriptionType } from './auth.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { getInitialSettings, getSettingsForSource } from './settings/settings.js'
import { workflowAvailability, workflowsEnabled } from './ultracodePolicy.js'

let availability: ReturnType<typeof workflowAvailability> | undefined

function getWorkflowAvailability() {
  if (!feature('WORKFLOW_SCRIPTS')) return false
  availability ??= workflowAvailability({
    envEnabled: isEnvTruthy(process.env.CLAUDE_CODE_WORKFLOWS),
    envDisabled: isEnvDefinedFalsy(process.env.CLAUDE_CODE_WORKFLOWS),
    gateEnabled: getFeatureValue_CACHED_MAY_BE_STALE('tengu_workflows_enabled', true),
    subscription: getSubscriptionType(),
  })
  return availability
}

/** Keep the settings switch visible after a user disables workflows, while
 * rollout, environment and managed policy still control availability. */
export function canConfigureWorkflows(): boolean {
  const available = getWorkflowAvailability()
  return Boolean(available && available.available &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOWS) &&
    isPolicyAllowed('allow_workflows') &&
    getSettingsForSource('policySettings')?.disableWorkflows !== true)
}

export function isWorkflowsEnabled(): boolean {
  // Build availability never overrides the user's or organization's disable.
  const available = getWorkflowAvailability()
  if (!available) return false
  return workflowsEnabled({
    settings: getInitialSettings(),
    disabledByEnv: isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOWS),
    policyAllowed: isPolicyAllowed('allow_workflows'),
    availability: available,
  })
}

export async function refreshWorkflowCommands(): Promise<void> {
  const { clearCommandMemoizationCaches } = await import('../commands.js')
  clearCommandMemoizationCaches()
  const { skillChangeDetector } = await import('./skills/skillChangeDetector.js')
  skillChangeDetector.emit()
}
