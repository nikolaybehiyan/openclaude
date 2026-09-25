import type { SDKActiveGoalMessage } from '../../entrypoints/sdk/coreTypes.js'
import type { ActiveGoal } from '../../utils/goal.js'

export function encodeActiveGoal(goal: ActiveGoal | undefined): SDKActiveGoalMessage['value'] {
  return goal ? {condition: goal.condition, iterations: goal.iterations, set_at: goal.setAt,
    tokens_at_start: goal.tokensAtStart,
    ...(goal.lastReason !== undefined ? {last_reason: goal.lastReason} : {})} : null
}
export function decodeActiveGoal(value: SDKActiveGoalMessage['value']): ActiveGoal | undefined {
  return value ? {condition: value.condition, iterations: value.iterations, setAt: value.set_at,
    tokensAtStart: value.tokens_at_start,
    ...(value.last_reason !== undefined ? {lastReason: value.last_reason} : {})} : undefined
}
