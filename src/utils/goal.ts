import { randomUUID } from 'node:crypto'
import { getSessionId, getTotalOutputTokens } from '../bootstrap/state.js'
import type { AppState } from '../state/AppStateStore.js'
import type { ToolUseContext } from '../Tool.js'
import type { GoalStatusAttachment, Message } from '../types/message.js'
import { shouldSkipHookDueToTrust } from './hooks.js'
import { shouldAllowManagedHooksOnly, shouldDisableAllHooksIncludingManaged } from './hooks/hooksConfigSnapshot.js'
import { addSessionHook, getSessionHooks, removeSessionHook } from './hooks/sessionHooks.js'
import type { PromptHook } from './settings/types.js'

// 2.1.226 Mjt: goals are session Stop hooks, not persistent tasks or token budgets.
export type ActiveGoal = {
  condition: string
  iterations: number
  setAt: number
  tokensAtStart: number
  lastReason?: string
}
export const MAX_GOAL_LENGTH = 4000
const CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])
export const isGoalClearArgument = (value: string): boolean => CLEAR_ALIASES.has(value.toLowerCase())
export const goalStartPrompt = (condition: string): string => `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`

export function goalUnavailableReason(): string | null {
  if (shouldDisableAllHooksIncludingManaged() || shouldAllowManagedHooksOnly()) {
    return "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy)."
  }
  if (shouldSkipHookDueToTrust()) return '/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.'
  return null
}

export function getGoalHooks(state: AppState, sessionId: string = getSessionId()): PromptHook[] {
  return (getSessionHooks(state, sessionId, 'Stop').get('Stop') ?? [])
    .filter(matcher => matcher.matcher === '' && matcher.skillRoot === undefined)
    .flatMap(matcher => matcher.hooks.filter((hook): hook is PromptHook => hook.type === 'prompt'))
}

type GoalCommandContext = Pick<ToolUseContext, 'getAppState' | 'setAppState'> & {
  setMessages: (update: (messages: Message[]) => Message[]) => void
}

export function createGoalStatusMessage(attachment: Omit<GoalStatusAttachment, 'type'>): Message {
  return { type: 'attachment', uuid: randomUUID(), timestamp: new Date().toISOString(),
    attachment: { type: 'goal_status', ...attachment } }
}

export function setSessionGoal(condition: string, context: GoalCommandContext): string | null {
  const unavailable = goalUnavailableReason()
  if (unavailable !== null) return unavailable
  const sessionId = getSessionId()
  for (const hook of getGoalHooks(context.getAppState(), sessionId)) {
    removeSessionHook(context.setAppState, sessionId, 'Stop', hook)
  }
  addSessionHook(context.setAppState, sessionId, 'Stop', '', { type: 'prompt', prompt: condition })
  context.setAppState(state => ({ ...state, activeGoal: {
    condition, iterations: 0, setAt: Date.now(), tokensAtStart: getTotalOutputTokens(),
  } }))
  context.setMessages(messages => [...messages, createGoalStatusMessage({ met: false, sentinel: true, condition })])
  return null
}

export function clearSessionGoal(context: GoalCommandContext): string | null {
  const sessionId = getSessionId()
  const hooks = getGoalHooks(context.getAppState(), sessionId)
  const activeGoal = context.getAppState().activeGoal
  // The Stop runner temporarily removes the hook while background tasks run.
  // Clearing the active goal must still win over its deferred restoration.
  if (!hooks.length && !activeGoal) return null
  for (const hook of hooks) removeSessionHook(context.setAppState, sessionId, 'Stop', hook)
  context.setAppState(state => state.activeGoal === undefined ? state : { ...state, activeGoal: undefined })
  const condition = activeGoal?.condition ?? hooks[0]!.prompt
  context.setMessages(messages => [...messages, createGoalStatusMessage({ met: true, sentinel: true, condition })])
  return condition
}

export function getLastAchievedGoal(messages: readonly Message[]): GoalStatusAttachment | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment' && message.attachment?.type === 'goal_status' &&
      message.attachment.met && !message.attachment.sentinel) return message.attachment
  }
  return null
}

// HJe/Evo: pending work also defers evaluation; idle peers and long-running
// remote agents do not keep a goal from being checked indefinitely.
export function hasGoalBackgroundWork(tasks: Readonly<Record<string, {
  type: string; status: string; isIdle?: boolean; isLongRunning?: boolean
}>>): boolean {
  return Object.values(tasks).some(task => {
    if (['completed', 'failed', 'killed'].includes(task.status)) return false
    if (task.type === 'local_bash') return true
    if (!['local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow'].includes(task.type)) return false
    return !(task.type === 'in_process_teammate' && task.isIdle) && !(task.type === 'remote_agent' && task.isLongRunning)
  })
}
