import type { LocalJSXCommandContext } from '../../types/command.js'
import { clearSessionGoal, goalStartPrompt, isGoalClearArgument, MAX_GOAL_LENGTH, setSessionGoal } from '../../utils/goal.js'

export async function call(args: string, context: LocalJSXCommandContext): Promise<
  {type: 'text'; value: string} | {type: 'query'; value: string; prompt: string}
> {
  const condition = args.trim()
  if (!condition) {
    const goal = context.getAppState().activeGoal
    if (!goal) return { type: 'text', value: 'No goal set. Usage: `/goal <condition>`' }
    const evaluation = goal.iterations === 0 ? 'not yet evaluated' : `${goal.iterations} ${goal.iterations === 1 ? 'turn' : 'turns'}`
    const last = goal.lastReason ? `\nLast check: ${goal.lastReason.trim().split('\n', 1)[0]}` : ''
    return { type: 'text', value: `Goal active: ${goal.condition} (${evaluation})${last}` }
  }
  if (isGoalClearArgument(condition)) {
    const cleared = clearSessionGoal(context)
    return { type: 'text', value: cleared === null ? 'No goal set' : `Goal cleared: ${cleared}` }
  }
  if (condition.length > MAX_GOAL_LENGTH) return { type: 'text', value: `Goal condition is limited to ${MAX_GOAL_LENGTH} characters (got ${condition.length})` }
  const error = setSessionGoal(condition, context)
  if (error !== null) return { type: 'text', value: error }
  return { type: 'query', value: `Goal set: ${condition}`, prompt: goalStartPrompt(condition) }
}
