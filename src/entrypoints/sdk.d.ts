// Type declarations for @gitlawb/openclaude SDK
// Manually maintained — keep in sync with src/entrypoints/sdk/index.ts
// Drift is caught by validate-externals.ts (runs in CI)

/** Configure once before creating a session; a different binding requires a new process. */
export type DarbFrozenModelContext = Readonly<{
  owner: 'identity-org-service'
  organization_uuid: string
  account_uuid: string
  mode?: 'default'
  connection_id?: string
  connection_revision?: number
  catalog_revision: string
  model: string
  supports_1m: boolean
  context_window_tokens: 0 | 1000000
  max_context_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
}>
export function configureDarbFrozenModelContext(input: unknown): DarbFrozenModelContext

// ============================================================================
// Error
// ============================================================================

export class AbortError extends Error {
  override readonly name: 'AbortError'
}

export class ClaudeError extends Error {
  constructor(message: string)
}

export class SDKError extends ClaudeError {
  constructor(message: string)
}

export class SDKAuthenticationError extends SDKError {
  constructor(message?: string)
}

export class SDKBillingError extends SDKError {
  constructor(message?: string)
}

export class SDKRateLimitError extends SDKError {
  readonly resetsAt?: number
  readonly rateLimitType?: string
  constructor(message?: string, resetsAt?: number, rateLimitType?: string)
}

export class SDKInvalidRequestError extends SDKError {
  constructor(message?: string)
}

export class SDKServerError extends SDKError {
  constructor(message?: string)
}

export class SDKMaxOutputTokensError extends SDKError {
  constructor(message?: string)
}

export type SDKAssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'DirectoryAdded'
  | 'FileChanged'

export function sdkErrorFromType(
  errorType: SDKAssistantMessageError,
  message?: string,
): SDKError | ClaudeError

// ============================================================================
// Types
// ============================================================================

export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth' | 'none'

export type RewindFilesResult = {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export type SDKMessagesContentBlock = Record<string, unknown>

export type SDKMessagesMessageParam = {
  role: 'user' | 'assistant'
  content: string | SDKMessagesContentBlock[]
}

export type SDKMessagesMcpServerParam = {
  type?: 'url'
  name: string
  url: string
}

export type SDKMessagesCreateParams = {
  model: string
  max_tokens: number
  messages: SDKMessagesMessageParam[]
  system?: string | SDKMessagesContentBlock[]
  tools?: Array<Record<string, unknown>>
  mcp_servers?: SDKMessagesMcpServerParam[]
  stream?: boolean
  temperature?: number
  top_p?: number
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export type SDKResolvedMcpServer = {
  name: string
  url: string
  sourceUrl?: string
  transportType?: 'streamable-http' | 'sse'
  allowedTools?: string[]
  headers?: Record<string, string>
}

export type SDKMessagesProviderOverride = {
  model: string
  baseURL: string
  apiKey: string
  apiFormat?: 'chat_completions'
}

export type SDKMessagesRuntimeOptions = {
  providerOverride: SDKMessagesProviderOverride
  systemPrompt: string
  resolvedMcpServers?: SDKResolvedMcpServer[]
  signal?: AbortSignal
  cwd?: string
}

export type SDKMessagesResponse = {
  id: string
  type: 'message'
  role: 'assistant'
  content: SDKMessagesContentBlock[]
  model: string
  stop_reason: string | null
  stop_sequence: string | null
  usage: Record<string, unknown>
  [key: string]: unknown
}

export function unstable_messagesCreate(
  params: SDKMessagesCreateParams,
  options: SDKMessagesRuntimeOptions,
): Promise<SDKMessagesResponse>

export type McpServerStatus = {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  serverInfo?: { name: string; version: string }
  error?: string
  scope?: string
  tools?: {
    name: string
    description?: string
    annotations?: {
      readOnly?: boolean
      destructive?: boolean
      openWorld?: boolean
    }
  }[]
}

export type PermissionResult = ({
  behavior: 'allow'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: ({
    type: 'addRules'
    rules: { toolName: string; ruleContent?: string }[]
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }) | ({
    type: 'replaceRules'
    rules: { toolName: string; ruleContent?: string }[]
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }) | ({
    type: 'removeRules'
    rules: { toolName: string; ruleContent?: string }[]
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }) | ({
    type: 'setMode'
    mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }) | ({
    type: 'addDirectories'
    directories: string[]
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }) | ({
    type: 'removeDirectories'
    directories: string[]
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  })[]
  toolUseID?: string
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject'
}) | ({
  behavior: 'deny'
  message: string
  interrupt?: boolean
  toolUseID?: string
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject'
})

export type SDKSessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  tag?: string
  createdAt?: number
}

export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeWorktrees?: boolean
}

export type GetSessionInfoOptions = {
  dir?: string
}

export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export type SessionMutationOptions = {
  dir?: string
}

export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}

export type ForkSessionResult = {
  sessionId: string
}

export type SessionMessage = {
  role: 'user' | 'assistant' | 'system'
  content: unknown
  timestamp?: string
  uuid?: string
  parentUuid?: string | null
  [key: string]: unknown
}

// Re-export precise SDK message types from generated types
// These use camelCase field names and discriminated unions for full IntelliSense
import type {
  SDKMessage,
  SDKUserMessage,
  SDKResultMessage,
} from './sdk/coreTypes.generated.js'

export type {
  SDKMessage,
  SDKUserMessage,
  SDKResultMessage,
} from './sdk/coreTypes.generated.js'

// ============================================================================
// Query types
// ============================================================================

export type QueryPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'plan'
  // Legacy Agent SDK spellings remain accepted for compatibility.
  | 'auto-accept'
  | 'bypass-permissions'
  | 'bypassPermissions'
  | 'acceptEdits'

export type SdkPluginConfig = {
  type: 'local'
  path: string
}

export type QueryOptions = {
  cwd: string
  additionalDirectories?: string[]
  model?: string
  sessionId?: string
  /** Fork the session before resuming (requires sessionId). */
  fork?: boolean
  /** Alias for fork. When true, resumed session forks to a new session ID. */
  forkSession?: boolean
  /** Resume the most recent session for this cwd (no sessionId needed). */
  continue?: boolean
  resume?: string
  /** When resuming, resume messages up to and including this message UUID. */
  resumeSessionAt?: string
  permissionMode?: QueryPermissionMode
  abortController?: AbortController
  executable?: string
  allowDangerouslySkipPermissions?: boolean
  /** Tools to allow without prompting. */
  allowedTools?: string[]
  disallowedTools?: string[]
  /**
   * Built-in tools to make available to Claude. When set, unlisted built-ins
   * are removed from context. SDK MCP/custom tools are unaffected.
   */
  tools?: string[]
  hooks?: Record<string, unknown[]>
  mcpServers?: Record<string, unknown>
  /** Local plugin roots loaded by OpenClaude's native plugin loader. */
  plugins?: SdkPluginConfig[]
  settings?: {
    env?: Record<string, string>
    attribution?: { commit: string; pr: string }
  }
  /** Environment variables to apply during query execution. Overrides process.env. Takes precedence over settings.env. */
  env?: Record<string, string | undefined>
  /**
   * Callback invoked before each tool use. Return `{ behavior: 'allow' }` to
   * permit the call or `{ behavior: 'deny', message?: string }` to reject it.
   *
   * **Secure-by-default**: If `canUseTool` is not provided, tool requests that
   * require approval are denied.
   */
  canUseTool?: (
    name: string,
    input: unknown,
    options?: { toolUseID?: string },
  ) => Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }>
  systemPrompt?:
    | string
    | string[]
    | { type: 'preset'; preset: string; append?: string }
    | { type: 'custom'; content: string }
  /** Extra Task-child guidance (gated by CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT). */
  appendSubagentSystemPrompt?: string
  planModeInstructions?: string
  /** Single-hop execution redirects; policy checks still apply to the target. */
  toolAliases?: Record<string, string>
  /** Agent definitions to register with the query engine. */
  agents?: Record<string, {
    description: string
    prompt: string
    tools?: string[]
    disallowedTools?: string[]
    model?: string
    maxTurns?: number
  }>
  settingSources?: string[]
  /** When true, yields stream_event messages for token-by-token streaming. */
  includePartialMessages?: boolean
  stderr?: (data: string) => void
}

export interface Query {
  readonly sessionId: string
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>
  setModel(model: string): Promise<void>
  setPermissionMode(mode: QueryPermissionMode): Promise<void>
  close(): void
  interrupt(): void
  /** Check if file rewind is possible. */
  rewindFiles(): RewindFilesResult
  /** Actually perform the file rewind. Returns files changed and diff stats. */
  rewindFilesAsync(): Promise<RewindFilesResult>
  supportedCommands(): string[]
  supportedModels(): string[]
  supportedAgents(): string[]
  mcpServerStatus(): McpServerStatus[]
  accountInfo(): Promise<{ apiKeySource: ApiKeySource; [key: string]: unknown }>
  setMaxThinkingTokens(tokens: number): void
}

/**
 * A message emitted when agent definitions fail to load.
 * This allows hosts to detect configuration issues that would otherwise
 * be silently logged to console.warn.
 *
 * Note: Agent load failures are non-fatal — the query continues without agents.
 */
export type SDKAgentLoadFailureMessage = {
  type: 'agent_load_failure'
  stage: 'definitions' | 'injection'
  error_message: string
}

// ============================================================================
// V2 API types
// ============================================================================

export type SDKSessionOptions = {
  cwd: string
  /** Additional directories the agent can access during this session. */
  additionalDirectories?: string[]
  /** Filesystem-based setting sources to load for this session. */
  settingSources?: string[]
  model?: string
  permissionMode?: QueryPermissionMode
  abortController?: AbortController
  /**
   * Callback invoked before each tool use. Return `{ behavior: 'allow' }` to
   * permit the call or `{ behavior: 'deny', message?: string }` to reject it.
   *
   * **Secure-by-default**: If `canUseTool` is not provided, tool requests that
   * require approval are denied.
   */
  canUseTool?: (
    name: string,
    input: unknown,
    options?: { toolUseID?: string },
  ) => Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }>
  /** MCP server configurations for this session. */
  mcpServers?: Record<string, unknown>
  /**
   * Non-blocking observer for successful native plugin MCP tools/list results.
   * Reporter failures never affect the session or the model request.
   */
  mcpToolReporter?: (report: SDKMcpToolReport) => void | Promise<void>
  /** Local plugin roots loaded by OpenClaude's native plugin loader. */
  plugins?: SdkPluginConfig[]
  /**
   * Built-in tools to make available to Claude. When set, unlisted built-ins
   * are removed from context. SDK MCP/custom tools are unaffected.
   */
  tools?: string[]
  /** Tools to allow without prompting. */
  allowedTools?: string[]
  /** Tools to disallow (blanket deny by tool name). */
  disallowedTools?: string[]
  /** Custom system prompt for persistent SDK sessions. */
  systemPrompt?:
    | string
    | string[]
    | { type: 'preset'; preset: string; append?: string }
    | { type: 'custom'; content: string }
  /** Additional system prompt text appended after the selected base/custom prompt. */
  appendSystemPrompt?: string
  appendSubagentSystemPrompt?: string
  planModeInstructions?: string
  toolAliases?: Record<string, string>
  /** Thinking configuration for persistent SDK sessions. */
  thinkingConfig?: ThinkingConfig
  /** Override max output tokens for the model request. */
  maxOutputTokens?: number
  /** Override request temperature when the API layer permits it. */
  temperature?: number
  /** Bound the number of model/tool turns for this SDK session. */
  maxTurns?: number
  /** Route this SDK session through a specific OpenAI-compatible provider. */
  providerOverride?: { model: string; baseURL: string; apiKey: string }
  /** Persist this SDK session transcript. Defaults to the normal OpenClaude policy. */
  persistSession?: boolean
  /** In-memory flag settings for this session. Used by managed/headless hosts. */
  settings?: Record<string, unknown>
  /** When true, yields stream_event messages for token-by-token streaming. */
  includePartialMessages?: boolean
  /**
   * When true, yields OpenClaude's native non-meta user-message replays.
   * Managed hosts use this to observe slash-command lifecycle metadata without
   * reconstructing command or skill expansion outside QueryEngine.
   */
  replayUserMessages?: boolean
  /** Native OpenClaude/CCR-style durable transcript event writer. */
  sessionEventWriter?: SDKSessionEventWriter
  /** Native OpenClaude/CCR-style foreground transcript event reader for resume. */
  sessionEventReader?: SDKSessionEventReader
  /** Native OpenClaude/CCR-style subagent transcript event reader for resume. */
  sessionSubagentEventReader?: SDKSessionEventReader
  /** In-memory session hooks backed by OpenClaude's native session hook runtime. */
  hooks?: SDKSessionFunctionHooks
}

export type SDKMcpToolReport = {
  serverName: string
  tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
    searchHint?: string
    alwaysLoad?: boolean
    _meta?: Record<string, unknown>
  }>
}

export type SDKSessionFunctionHook = {
  matcher?: string
  id?: string
  timeout?: number
  errorMessage?: string
  callback: (messages: unknown[], signal?: AbortSignal) => boolean | Promise<boolean>
}

export type SDKSessionFunctionHooks = Partial<Record<HookEvent, SDKSessionFunctionHook[]>>

export type SDKSessionUpdateOptions = Pick<
  SDKSessionOptions,
  | 'model'
  | 'permissionMode'
  | 'additionalDirectories'
  | 'mcpServers'
  | 'plugins'
  | 'tools'
  | 'allowedTools'
  | 'disallowedTools'
  | 'thinkingConfig'
>

export interface SDKSession {
  sessionId: string
  sendMessage(content: string, options?: { uuid?: string }): AsyncIterable<SDKMessage>
  /** Regenerate an assistant response from an existing user message UUID. */
  retryMessage(parentUserMessageUuid: string): AsyncIterable<SDKMessage>
  /** Update live per-turn session options without replacing session history. */
  updateOptions(options: SDKSessionUpdateOptions): void
  /** Reload filesystem-backed skills before the next turn without replacing session history. */
  reloadSkills(): void
  /** Reload native plugin components without replacing session history. */
  reloadPlugins(): Promise<void>
  /** Replace SDK session history with a host-provided active conversation path. */
  unstable_syncMessages(messages: unknown[]): void
  getMessages(): SDKMessage[]
  interrupt(): void
  /** Stop one running background task by source task id. */
  stopTask(taskId: string): Promise<SDKStopTaskResult>
  /** Generate a source-compatible AI session title from a first-message description. */
  generateSessionTitle(description: string): Promise<string | null>
  /** Answer a source-compatible side question using the last completed turn cache context. */
  sideQuestion(question: string): Promise<SDKSideQuestionResult>
  /** Close the session and release resources (MCP connections, etc.). */
  close(): void
}

export type SDKStopTaskResult = {
  taskId: string
  taskType: string
  command: string | undefined
}

export type SDKSideQuestionResult = {
  response: string | null
  usage: Record<string, unknown>
}

export type SDKSessionEventWriter = (
  eventType: string,
  payload: Record<string, unknown>,
  options?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>

export type SDKSessionEventReader = () => Promise<
  { payload: Record<string, unknown>; agent_id?: string }[] | null
>

// ============================================================================
// MCP tool types
// ============================================================================

export interface SdkMcpToolDefinition<Schema = any> {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: any, extra: unknown) => Promise<any>
  annotations?: any
  permissionBehavior?: 'allow' | 'ask' | 'deny'
  searchHint?: string
  alwaysLoad?: boolean
  deferInputValidationToHandler?: boolean
  _meta?: Record<string, unknown>
}

// ============================================================================
// Session functions
// ============================================================================

export function listSessions(
  options?: ListSessionsOptions,
): Promise<SDKSessionInfo[]>

export function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined>

export function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]>

export function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions,
): Promise<void>

export function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions,
): Promise<void>

export function forkSession(
  sessionId: string,
  options?: ForkSessionOptions,
): Promise<ForkSessionResult>

export function deleteSession(
  sessionId: string,
  options?: SessionMutationOptions,
): Promise<void>

// ============================================================================
// Query functions
// ============================================================================

export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: QueryOptions
}): Query

export function queryAsync(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: QueryOptions
}): Promise<Query>

// ============================================================================
// V2 API functions
// ============================================================================

export function unstable_v2_createSession(options: SDKSessionOptions): SDKSession

export function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions,
): Promise<SDKSession>

export function unstable_v2_prompt(
  message: string,
  options: SDKSessionOptions,
): Promise<SDKResultMessage>

export function unstable_v2_generateSessionTitle(
  description: string,
  signal?: AbortSignal,
): Promise<string | null>

export type SDKTitleAndBranchResult = {
  title: string
  branchName: string
}

export function unstable_v2_generateTitleAndBranch(
  description: string,
  signal?: AbortSignal,
): Promise<SDKTitleAndBranchResult>

/**
 * Initialize the SDK runtime without creating a session or sending a message.
 */
export function unstable_v2_initializeRuntime(): Promise<void>

// ============================================================================
// MCP tool functions
// ============================================================================

export function tool<Schema = any>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: any, extra: unknown) => Promise<any>,
  extras?: {
    annotations?: any
    permissionBehavior?: 'allow' | 'ask' | 'deny'
    searchHint?: string
    alwaysLoad?: boolean
    deferInputValidationToHandler?: boolean
    _meta?: Record<string, unknown>
  },
): SdkMcpToolDefinition<Schema>

/**
 * MCP server transport configuration types.
 * Matches McpServerConfigForProcessTransport from coreTypes.generated.ts.
 */
export type SdkMcpStdioConfig = {
  type?: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type SdkMcpSSEConfig = {
  type: "sse"
  url: string
  headers?: Record<string, string>
  /** Limit this session-scoped server to the named upstream MCP tools. */
  toolAllowlist?: string[]
}

export type SdkMcpHttpConfig = {
  type: "http"
  url: string
  headers?: Record<string, string>
  /** Limit this session-scoped server to the named upstream MCP tools. */
  toolAllowlist?: string[]
}

export type SdkMcpSdkConfig = {
  type: "sdk"
  name: string
  /** In-process tool definitions created via the tool() helper. */
  tools?: SdkMcpToolDefinition[]
}

export type SdkClientMcpToolDefinition<Schema = any> = {
  name: string
  description: string
  inputSchema: Schema
  annotations?: any
  permissionBehavior?: 'allow' | 'ask' | 'deny'
  searchHint?: string
  alwaysLoad?: boolean
  deferInputValidationToHandler?: boolean
  _meta?: Record<string, unknown>
}

export type SdkClientMcpCall = {
  serverName: string
  toolName: string
  args: any
  extra: unknown
}

export type SdkClientMcpServerOptions = {
  name: string
  tools: SdkClientMcpToolDefinition[]
  callTool: (call: SdkClientMcpCall) => Promise<any>
}

export type SdkMcpServerConfig = SdkMcpStdioConfig | SdkMcpSSEConfig | SdkMcpHttpConfig | SdkMcpSdkConfig

export type AutoMemoryConsolidationPromptOptions = {
  memoryRoot: string
  transcriptDir: string
  extra?: string
}

export type AutoMemoryCanUseToolOptions = {
  cwd?: string
}

export type AutoMemoryProjectionEntry = {
  line_number: number
  text: string
  file: string
  source_line: number
  name?: string
  description?: string
  type?: string
}

export type AutoMemoryProjection = {
  memory: string
  controls: string[]
  entries: AutoMemoryProjectionEntry[]
  files: string[]
}

export type AutoMemoryRuntimeState = {
  autoMemoryEnabled: boolean
  extractModeActive: boolean
  isRemoteMode: boolean
  isNonInteractiveSession: boolean
  autoMemPath: string
}

export function unstable_buildAutoMemoryConsolidationPrompt(options: AutoMemoryConsolidationPromptOptions): string

export function unstable_didAutoDreamFireSince(sinceMs: number): Promise<boolean>

export function unstable_createAutoMemoryCanUseTool(
  memoryDir: string,
  options?: AutoMemoryCanUseToolOptions,
): NonNullable<QueryOptions['canUseTool']>

export function unstable_initAutoMemoryLifecycle(): void

export function unstable_drainAutoMemoryExtraction(timeoutMs?: number): Promise<void>

export function unstable_getAutoMemoryToolNames(): string[]

export function unstable_getAutoMemoryRuntimeState(): AutoMemoryRuntimeState

export function unstable_readAutoMemoryProjection(memoryRoot: string): Promise<string>

export function unstable_readAutoMemoryProjectionDetails(memoryRoot: string): Promise<AutoMemoryProjection>

export function unstable_shutdownRuntime(): Promise<void>

/**
 * Scoped MCP server config with session scope.
 * Returned by createSdkMcpServer() for use with mcpServers option.
 */
export type SdkScopedMcpServerConfig = SdkMcpServerConfig & {
  scope: "session"
}

/**
 * Wraps an MCP server configuration for use with the SDK.
 * Adds the 'session' scope marker so the SDK knows this server
 * should be connected per-session (not globally).
 *
 * @param config - MCP server config (stdio, sse, http, or sdk type)
 * @returns Scoped config with scope: 'session' added
 *
 * @example
 * ```typescript
 * const server = createSdkMcpServer({
 *   type: 'stdio',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
 * })
 * const session = unstable_v2_createSession({
 *   cwd: '/my/project',
 *   mcpServers: { 'fs': server },
 * })
 * ```
 */
export function createSdkMcpServer(config: SdkMcpServerConfig): SdkScopedMcpServerConfig

/**
 * Creates a session-scoped MCP server whose execution is delegated to a
 * client host while OpenClaude retains tool selection and the agent loop.
 */
export function createSdkClientMcpServer(options: SdkClientMcpServerOptions): SdkScopedMcpServerConfig
