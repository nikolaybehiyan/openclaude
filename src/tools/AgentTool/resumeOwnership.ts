import { randomUUID } from 'node:crypto'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import { isLocalAgentKeptAlive, isLocalAgentTask, type LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'

export class AgentResumeStateError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentResumeStateError' }
}

// Also covers cold transcript resumes, for which no task exists in AppState yet.
const reservations = new Map<string, string>()

export function reserveAgentResume(input: {
  agentId: string
  getAppState: () => AppState
  setAppState: SetAppState
  expectedTask?: LocalAgentTaskState
}) {
  const { agentId, getAppState, setAppState, expectedTask } = input
  if (reservations.has(agentId)) throw new AgentResumeStateError(`Agent ${agentId} is already being resumed`)
  const token = randomUUID()
  reservations.set(agentId, token)
  function release() {
    if (reservations.get(agentId) !== token) return
    reservations.delete(agentId)
    setAppState(state => {
      const task = state.tasks[agentId]
      if (!isLocalAgentTask(task) || task.resuming !== token) return state
      return { ...state, tasks: { ...state.tasks, [agentId]: { ...task, resuming: undefined } } }
    })
  }
  function assertEligible() {
    const task = getAppState().tasks[agentId]
    if (reservations.get(agentId) !== token || isLocalAgentTask(task) && (task.status === 'running' || task.resuming && task.resuming !== token)) {
      throw new AgentResumeStateError(`Agent ${agentId} is already running or being resumed`)
    }
    if (expectedTask && (!isLocalAgentKeptAlive(task) || task.stoppedByUser || task.executionId !== expectedTask.executionId)) {
      throw new AgentResumeStateError(`Agent ${agentId} no longer accepts this workflow result`)
    }
  }
  try {
    assertEligible()
    setAppState(state => {
      const task = state.tasks[agentId]
      if (!isLocalAgentTask(task)) return state
      return { ...state, tasks: { ...state.tasks, [agentId]: { ...task, resuming: token } } }
    })
  } catch (error) { release(); throw error }
  return { assertEligible, release }
}
