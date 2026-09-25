import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isPolicyAllowed } from '../services/policyLimits/index.js'
import { getSubscriptionType } from './auth.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'
import { workflowAvailability, workflowsEnabled } from './ultracodePolicy.js'

let availability: ReturnType<typeof workflowAvailability> | undefined

export function isWorkflowsEnabled(): boolean {
  // A policy/selector fix cannot invent the absent executor. Enable the build
  // feature only with its complete WorkflowTool/task/runtime source qualified.
  if (!feature('WORKFLOW_SCRIPTS')) return false
  availability ??= workflowAvailability({
    envEnabled: isEnvTruthy(process.env.CLAUDE_CODE_WORKFLOWS),
    envDisabled: isEnvDefinedFalsy(process.env.CLAUDE_CODE_WORKFLOWS),
    gateEnabled: getFeatureValue_CACHED_MAY_BE_STALE('tengu_workflows_enabled', true),
    subscription: getSubscriptionType(),
  })
  return workflowsEnabled({
    settings: getInitialSettings(),
    disabledByEnv: isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOWS),
    policyAllowed: isPolicyAllowed('allow_workflows'),
    availability,
  })
}
