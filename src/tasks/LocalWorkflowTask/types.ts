import type { TaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import type { WorkflowMeta } from '../../tools/WorkflowTool/scriptParser.js'

export type WorkflowAgentProgress = {
  type: 'workflow_agent'
  index: number
  label: string
  state: 'start' | 'progress' | 'done' | 'error'
  phaseIndex?: number
  phaseTitle?: string
  agentId?: string
  agentType?: string
  isolation?: 'worktree' | 'remote'
  model?: string
  fallbackModel?: string
  remoteSessionId?: string
  tokens?: number
  toolCalls?: number
  durationMs?: number
  startedAt?: number
  queuedAt?: number
  lastProgressAt?: number
  attempt?: number
  lastAttemptReason?: string
  lastToolName?: string
  lastToolSummary?: string
  promptPreview?: string
  resultPreview?: string
  error?: string
  blocked?: boolean
  skipped?: boolean
  cached?: boolean
}

export type WorkflowPhaseProgress = {
  type: 'workflow_phase'
  index: number
  title: string
  kind?: 'child'
}

export type SdkWorkflowProgress = WorkflowAgentProgress | WorkflowPhaseProgress
export type WorkflowProgress = SdkWorkflowProgress | { type: 'workflow_log'; message: string }

export type WorkflowTerminal = {
  summary: string
  output_file: string
  usage: { total_tokens: number; tool_uses: number; duration_ms: number }
}

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  script: string
  scriptPath?: string
  args?: unknown
  prompt: string
  summary?: string
  workflowName?: string
  title?: string
  phases?: WorkflowMeta['phases']
  defaultModel?: string
  workflowRunId: string
  ownerAgentId?: AgentId
  workflowProgress: WorkflowProgress[]
  progressVersion: number
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  logs: string[]
  result?: unknown
  error?: string
  abortController?: AbortController
  agentControllers?: Map<string, AbortController>
  outputReady?: Promise<string>
  terminal?: WorkflowTerminal
  evictAfter?: number
  /** XML is translated to the SDK bookend by print.ts; never emit both. */
  notificationDelivery?: 'xml' | 'sdk'
}
