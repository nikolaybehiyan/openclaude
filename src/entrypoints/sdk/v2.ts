/**
 * V2 API for the SDK — persistent sessions and one-shot prompt.
 *
 * Provides SDKSession, SDKSessionImpl, createEngineFromOptions,
 * and the unstable_v2_* functions.
 */

import { createHash, randomUUID } from 'crypto'
import { basename, dirname, extname } from 'path'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { QueryEngine } from '../../QueryEngine.js'
import {
  getDefaultAppState,
  type AppState,
} from '../../state/AppStateStore.js'
import { createStore, type Store } from '../../state/store.js'
import { getTools, getToolsForDefaultPreset } from '../../tools.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { init } from '../init.js'
import {
  canonicalizePath,
  getProjectDir,
  resolveSessionFilePath,
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from '../../utils/sessionStoragePortable.js'
import { readJSONLFile } from '../../utils/json.js'
import { stat } from 'fs/promises'
import {
  switchSession,
  runWithSdkContext,
  setProjectRoot,
  setFlagSettingsInline,
  setAllowedSettingSources,
  getSessionId,
} from '../../bootstrap/state.js'
import {
  hydrateFromCCRv2InternalEvents,
  setInternalEventReader,
  setInternalEventWriter,
} from '../../utils/sessionStorage.js'
import type { SessionId } from '../../types/ids.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js'
import type {
  HookEvent,
  SDKResultMessage as GeneratedSDKResultMessage,
  SdkPluginConfig,
} from './coreTypes.generated.js'
import { applySDKLocalPlugins } from './plugins.js'
import { initializeSDKLocalPlugins } from './pluginRuntime.js'
import type {
  SDKMessage,
  SDKAgentLoadFailureMessage,
  JsonlEntry,
  QueryPermissionMode,
  CanUseToolCallback,
} from './shared.js'
import {
  assertValidSessionId,
  mapMessageToSDK,
} from './shared.js'
import {
  buildPermissionContext,
  applyBuiltinToolsFilter,
  createExternalCanUseTool,
  connectSdkMcpServers,
  createDefaultCanUseTool,
} from './permissions.js'
import {
  parseJsonlEntries,
  findLastCompactBoundary,
  applyPreservedSegmentRelinks,
  buildConversationChain as buildChain,
  stripExtraFields as stripChainFields,
} from './transcript.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { parseSettingSourcesFlag } from '../../utils/settings/constants.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import { getRunningTasks } from '../../utils/task/framework.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { stopTask } from '../../tasks/stopTask.js'
import { hydrateToolProgressOutput } from './toolProgress.js'
import { sleep } from '../../utils/sleep.js'
import { dequeue } from '../../utils/messageQueueManager.js'
import {
  generateSessionTitle as generateSourceSessionTitle,
  titleOrNullForPromptFallback,
} from '../../utils/sessionTitle.js'
import { getLastCacheSafeParams } from '../../utils/forkedAgent.js'
import { runSideQuestion as runSourceSideQuestion } from '../../utils/sideQuestion.js'
import { createAbortController } from '../../utils/abortController.js'
import { addFunctionHook } from '../../utils/hooks/sessionHooks.js'
import { clearCommandsCache, getCommands } from '../../commands.js'
import { resetSentSkillNames } from '../../utils/attachments.js'
import type { Tool, ToolPermissionContext } from '../../Tool.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { buildMcpToolName } from '../../services/mcp/mcpStringUtils.js'
import type { Command } from '../../types/command.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import {
  assembleSDKMcpAppState,
  connectSDKMcpServersIncrementally,
  nativePluginMcpToolReport,
  partitionSDKMcpServerConfigsForStartup,
  resolveSDKMcpServerConfigs,
} from './mcpRuntime.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'

// ============================================================================
// V2 API Types
// ============================================================================

/**
 * Options for creating a persistent SDK session.
 * Used by unstable_v2_createSession and unstable_v2_resumeSession.
 */
export type SDKSessionOptions = {
  /** Working directory for the session. Required. */
  cwd: string
  /** Additional directories the agent can access during this session. */
  additionalDirectories?: string[]
  /** Filesystem-based setting sources to load for this session. */
  settingSources?: string[]
  /** Model to use (e.g. 'claude-sonnet-4-6'). */
  model?: string
  /** Permission mode for tool access. */
  permissionMode?: QueryPermissionMode
  /** AbortController to cancel the session. */
  abortController?: AbortController
  /**
   * Callback invoked before each tool use. Return `{ behavior: 'allow' }` to
   * permit the call or `{ behavior: 'deny', message?: string }` to reject it.
   *
   * **Secure-by-default**: If `canUseTool` is not provided, tool requests that
   * require approval are denied.
   */
  canUseTool?: CanUseToolCallback
  /** MCP server configurations for this session. */
  mcpServers?: Record<string, unknown>
  /** Observe schemas returned by native plugin MCP tools/list for durable host projection. */
  mcpToolReporter?: (report: SDKMcpToolReport) => void | Promise<void>
  /** @internal Observe coarse SDK lifecycle milestones without message content. */
  _lifecycleReporter?: (report: SDKSessionLifecycleReport) => void
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
    | { type: 'preset'; preset: string; append?: string }
    | { type: 'custom'; content: string }
  /** Additional system prompt text appended after the selected base/custom prompt. */
  appendSystemPrompt?: string
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
  /**
   * Native OpenClaude/CCR-style session event writer. SDK hosts that run
   * ephemeral workers can mirror transcript entries to durable storage without
   * reconstructing history outside QueryEngine.
   */
  sessionEventWriter?: SDKSessionEventWriter
  /**
   * Native OpenClaude/CCR-style foreground event reader used before resume.
   * It must return persisted transcript event payloads for this session.
   */
  sessionEventReader?: SDKSessionEventReader
  /**
   * Native OpenClaude/CCR-style subagent event reader used before resume.
   * If omitted, only the foreground transcript is hydrated.
   */
  sessionSubagentEventReader?: SDKSessionEventReader
  /** In-memory session hooks backed by OpenClaude's native session hook runtime. */
  hooks?: SDKSessionFunctionHooks
}

export type SDKSessionLifecycleReport = {
  phase: 'send_started' | 'init_ready' | 'runtime_ready' | 'agents_ready' | 'model_handoff'
  elapsedMs: number
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

/**
 * A persistent session wrapping a QueryEngine for multi-turn conversations.
 *
 * Each call to `sendMessage` starts a new turn within the same conversation.
 * State (messages, file cache, usage, etc.) persists across turns.
 *
 * **IMPORTANT: Resource Cleanup**
 * You MUST call `close()` when finished with a session to prevent memory leaks.
 * Abandoned sessions retain internal buffers (pending permission prompts and
 * agent failure queues) until explicitly closed. In long-running processes,
 * failing to close sessions can cause unbounded memory growth.
 *
 * @example
 * ```typescript
 * const session = unstable_v2_createSession({ cwd: '/my/project' });
 * try {
 *   for await (const msg of session.sendMessage('Hello!')) {
 *     console.log(msg);
 *   }
 * } finally {
 *   session.close(); // ALWAYS close the session
 * }
 * ```
 */
export interface SDKSession {
  /** Unique identifier for this session. */
  sessionId: string
  /** Send a message and yield responses as an AsyncIterable of SDKMessage. */
  sendMessage(content: string | ContentBlockParam[], options?: { uuid?: string }): AsyncIterable<SDKMessage>
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
  /** Return all messages accumulated so far in this session. */
  getMessages(): SDKMessage[]
  /** Abort the current in-flight query. */
  interrupt(): void
  /** Stop one running background task by source task id. */
  stopTask(taskId: string): Promise<SDKStopTaskResult>
  /** Generate a source-compatible AI session title from a first-message description. */
  generateSessionTitle(description: string): Promise<string | null>
  /** Answer a source-compatible side question using the last completed turn cache context. */
  sideQuestion(question: string): Promise<SDKSideQuestionResult>
  /** Close the session and release resources. */
  close(): void
}

/**
 * An SDKResultMessage is the final message emitted by a query turn,
 * containing the result text, usage stats, and cost information.
 * Re-exports the full generated type from coreTypes.generated.ts.
 */
export type SDKResultMessage = GeneratedSDKResultMessage

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

type SDKExecutionContext = {
  sessionId: SessionId
  sessionProjectDir: string | null
  cwd: string
  originalCwd: string
}

async function* runSdkContextIterable<T>(
  context: SDKExecutionContext,
  factory: () => AsyncIterable<T>,
): AsyncGenerator<T> {
  const iterator = runWithSdkContext(context, () => factory()[Symbol.asyncIterator]())
  try {
    while (true) {
      const result = await runWithSdkContext(context, () => iterator.next())
      if (result.done) {
        return result.value
      }
      yield result.value
    }
  } finally {
    if (iterator.return) {
      await runWithSdkContext(context, () => iterator.return?.())
    }
  }
}

// ============================================================================
// SdkMcpToolDefinition — tool() return type
// ============================================================================

/**
 * Describes a tool definition created by the `tool()` factory function.
 * These definitions can be passed to `createSdkMcpServer()` to register
 * custom MCP tools.
 */
export interface SdkMcpToolDefinition<Schema = any> {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: any, extra: unknown) => Promise<CallToolResult>
  annotations?: ToolAnnotations
  permissionBehavior?: 'allow' | 'ask' | 'deny'
  searchHint?: string
  alwaysLoad?: boolean
  deferInputValidationToHandler?: boolean
  _meta?: Record<string, unknown>
  /** Preserve native MCP identity when a schema is projected before transport startup. */
  mcpInfo?: { serverName: string; toolName: string }
}

type NativeMcpReadyResult =
  | { status: 'ready'; tools: Tool[] }
  | { status: 'failed'; error: Error }

type NativeMcpWaiter = {
  generation: number
  promise: Promise<NativeMcpReadyResult>
  resolve: (result: NativeMcpReadyResult) => void
}

// ============================================================================
// SDKSessionImpl — concrete SDKSession
// ============================================================================

class SDKSessionImpl implements SDKSession {
  private _engine: QueryEngine | null = null
  private get engine(): QueryEngine {
    if (!this._engine) {
      throw new Error('SDKSessionImpl: engine not initialized. Call setEngine() first.')
    }
    return this._engine
  }
  private _sessionId: string
  private options: SDKSessionOptions
  private _appStateStore: Store<AppState> | null = null
  private get appStateStore(): Store<AppState> {
    if (!this._appStateStore) {
      throw new Error('SDKSessionImpl: appStateStore not initialized. Call setAppStateStore() first.')
    }
    return this._appStateStore
  }
  private _abortController: AbortController | null = null
  private agentsLoaded = false
  private mcpServers?: Record<string, unknown>
  private mcpConnected = false
  private mcpTools: Tool[] = []
  private mcpConnectionGeneration = 0
  private mcpStartupPromise: Promise<void> | null = null
  private mcpClientsByServer = new Map<string, MCPServerConnection[]>()
  private mcpToolsByServer = new Map<string, Tool[]>()
  private nativeMcpWaiters = new Map<string, NativeMcpWaiter>()
  private commands: Command[] = []
  private skillsLoaded = false
  private pluginLifecycleLoaded = false
  private pluginLifecycleGeneration = 0
  private pluginLifecyclePromise: Promise<void> | null = null
  private agentFailureQueue: SDKAgentLoadFailureMessage[] = []
  /** Resolved transcript directory — dirname of the JSONL file, or null for default project dir */
  private _sessionProjectDir: string | null = null

  constructor(
    engine: QueryEngine | null,
    sessionId: string,
    options: SDKSessionOptions,
    appStateStore: Store<AppState> | null,
    abortController?: AbortController | null,
  ) {
    if (engine) this._engine = engine
    this._sessionId = sessionId
    this.options = options
    if (appStateStore) this._appStateStore = appStateStore
    if (abortController) this._abortController = abortController
    this.mcpServers = options.mcpServers
  }

  /** Late-bind the engine (used when session is created before engine). */
  setEngine(engine: QueryEngine): void {
    this._engine = engine
  }

  /** Late-bind the app state store (used when session is created before store). */
  setAppStateStore(store: Store<AppState>): void {
    this._appStateStore = store
  }

  /** Late-bind the abort controller (used when session is created before engine). */
  setAbortController(ac: AbortController): void {
    this._abortController = ac
  }

  /** Keep the mutable command registry shared with QueryEngine. */
  setCommands(commands: Command[]): void {
    this.commands = commands
  }

  /**
   * Mirror interactive startup: begin live plugin/MCP discovery as soon as the
   * persistent session exists, before the first user message is submitted.
   * This only primes native connections; it never delays session creation.
   */
  startBackgroundRuntime(): void {
    const sdkContext = {
      sessionId: this._sessionId as SessionId,
      sessionProjectDir: this._sessionProjectDir,
      cwd: this.options.cwd,
      originalCwd: this.options.cwd,
    }
    void runWithSdkContext(sdkContext, async () => {
      await init()
      const pluginStartup = this.ensurePluginLifecycleLoaded()
      const mcpStartup = this.ensureMcpServersConnected()
      await Promise.all([pluginStartup, mcpStartup])
    }).catch(error => {
      console.warn(
        'SDK: background plugin/MCP startup failed:',
        error instanceof Error ? error.message : String(error),
      )
    })
  }

  /** Set the resolved transcript directory (called by resumeSession after resolving the JSONL path). */
  setSessionProjectDir(dir: string): void {
    this._sessionProjectDir = dir
  }

  get sessionId(): string {
    return this._sessionId
  }

  updateOptions(options: SDKSessionUpdateOptions): void {
    if (!options || typeof options !== 'object') {
      return
    }

    const nextOptions = { ...this.options }
    let permissionContextChanged = false

    if (hasOwn(options, 'model')) {
      const model = normalizeOptionalSessionString(options.model, 'SDKSession.updateOptions.model')
      nextOptions.model = model
      if (model) {
        this.appStateStore.setState(prev => ({
          ...prev,
          mainLoopModel: model,
          mainLoopModelForSession: model,
        }))
        this.engine.setModel(model)
      }
    }

    if (hasOwn(options, 'thinkingConfig')) {
      const thinkingConfig = normalizeThinkingConfig(options.thinkingConfig)
      nextOptions.thinkingConfig = thinkingConfig
      if (thinkingConfig) {
        this.appStateStore.setState(prev => ({
          ...prev,
          thinkingEnabled: thinkingConfig.type !== 'disabled',
          thinkingBudgetTokens: thinkingConfig.type === 'enabled' ? thinkingConfig.budgetTokens : undefined,
        }))
        this.engine.setThinkingConfig(thinkingConfig)
      }
    }

    for (const key of ['permissionMode', 'additionalDirectories', 'tools', 'allowedTools', 'disallowedTools'] as const) {
      if (hasOwn(options, key)) {
        nextOptions[key] = options[key] as never
        permissionContextChanged = true
      }
    }

    let mcpServersChanged = false
    if (hasOwn(options, 'mcpServers')) {
      const nextMcpServers = options.mcpServers
      nextOptions.mcpServers = nextMcpServers
      // SDK MCP server configs may carry fresh handler closures even when their
      // serializable schemas are unchanged, so reference changes are meaningful.
      if (nextMcpServers !== this.mcpServers) {
        this.disconnectMcpClients('SDKSession.updateOptions.mcpServers')
        this.mcpServers = nextMcpServers
        this.mcpConnected = false
        this.mcpTools = []
        mcpServersChanged = true
      } else {
        this.mcpServers = nextMcpServers
      }
    }

    if (hasOwn(options, 'plugins')) {
      const applied = applySDKLocalPlugins(options.plugins)
      nextOptions.plugins = applied.paths.map(path => ({ type: 'local', path }))
      if (applied.changed) {
        this.invalidatePluginLifecycle()
        this.reloadSkills()
        this.agentsLoaded = false
        this.disconnectMcpClients('SDKSession.updateOptions.plugins')
        this.mcpConnected = false
        this.mcpTools = []
      }
    }

    this.options = nextOptions
    if (permissionContextChanged || mcpServersChanged) {
      this.applyPermissionContextFromOptions()
    }
    if (mcpServersChanged || hasOwn(options, 'plugins')) {
      this.startBackgroundRuntime()
    }
  }

  reloadSkills(): void {
    clearCommandsCache()
    resetSentSkillNames()
    this.skillsLoaded = false
  }

  async reloadPlugins(): Promise<void> {
    const generation = ++this.pluginLifecycleGeneration
    this.pluginLifecyclePromise = null
    this.pluginLifecycleLoaded = false
    await refreshActivePlugins(updater => this.appStateStore.setState(updater))
    if (generation === this.pluginLifecycleGeneration) {
      this.pluginLifecycleLoaded = true
    }
    this.reloadSkills()
    this.agentsLoaded = false
    this.disconnectMcpClients('SDKSession.reloadPlugins')
    this.mcpConnected = false
    this.mcpTools = []
    this.applyPermissionContextFromOptions()
    this.startBackgroundRuntime()
  }

  private async ensurePluginLifecycleLoaded(): Promise<void> {
    if (this.pluginLifecycleLoaded) {
      return
    }
    if (this.pluginLifecyclePromise) {
      await this.pluginLifecyclePromise
      return
    }
    const generation = this.pluginLifecycleGeneration
    const startup = initializeSDKLocalPlugins(updater => this.appStateStore.setState(updater))
    this.pluginLifecyclePromise = startup
    try {
      await startup
      if (generation === this.pluginLifecycleGeneration) {
        this.pluginLifecycleLoaded = true
      }
    } finally {
      if (this.pluginLifecyclePromise === startup) {
        this.pluginLifecyclePromise = null
      }
    }
  }

  private invalidatePluginLifecycle(): void {
    this.pluginLifecycleGeneration += 1
    this.pluginLifecyclePromise = null
    this.pluginLifecycleLoaded = false
  }

  private async ensureSkillsLoaded(): Promise<void> {
    if (this.skillsLoaded) {
      return
    }
    const commands = await getCommands(this.options.cwd)
    this.commands.splice(0, this.commands.length, ...commands)
    this.skillsLoaded = true
  }

  private async ensureSandboxReady(): Promise<void> {
    if (this.options.settings?.sandbox) {
      const unavailable = SandboxManager.getSandboxUnavailableReason()
      if (unavailable) {
        throw new Error(`Sandbox runtime is required but unavailable: ${unavailable}`)
      }
    }
    await SandboxManager.initialize(async () => false)
    if (
      this.options.settings?.sandbox &&
      !SandboxManager.isSandboxingEnabled()
    ) {
      throw new Error('Sandbox runtime is required but did not initialize')
    }
  }

  private async ensureAgentsLoaded(): Promise<void> {
    if (this.agentsLoaded) {
      return
    }
    try {
      const agentDefs = await getAgentDefinitionsWithOverrides(this.options.cwd)
      this.appStateStore.setState(prev => ({
        ...prev,
        agentDefinitions: agentDefs,
      }))
      // Loading plugin metadata is independent from exposing the Agent tool.
      // Chat intentionally hides Agent, so injecting those definitions into a
      // filtered main-thread tool pool would make native validation reject
      // legitimate plugin-agent tools such as Read. Code/Cowork expose Agent
      // and receive the full native definitions after MCP tools are connected.
      const visibleTools = mergeRuntimeTools(
        getTools(sdkVisiblePermissionContext(this.options)),
        this.mcpTools,
      )
      if (visibleTools.some(tool => tool.name === AGENT_TOOL_NAME)) {
        this.engine.injectAgents(agentDefs.activeAgents)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.warn('SDK: agent loading failed:', errorMessage)
      this.pushAgentFailure({
        type: 'agent_load_failure',
        stage: 'definitions',
        error_message: errorMessage,
      })
    }
    this.agentsLoaded = true
  }

  async *sendMessage(content: string | ContentBlockParam[], options?: { uuid?: string }): AsyncIterable<SDKMessage> {
	const lifecycleStartedAt = Date.now()
	const reportLifecycle = (phase: SDKSessionLifecycleReport['phase']) => {
	  try {
		this.options._lifecycleReporter?.({ phase, elapsedMs: Date.now() - lifecycleStartedAt })
	  } catch {
		// Diagnostics are observational and must never affect a turn.
	  }
	}
	reportLifecycle('send_started')
    const sdkContext = {
      sessionId: this._sessionId as SessionId,
      sessionProjectDir: this._sessionProjectDir,
      cwd: this.options.cwd,
      originalCwd: this.options.cwd,
    }

    const self = this
    const inner = runSdkContextIterable(sdkContext, () => {
      return (async function* (): AsyncGenerator<SDKMessage> {
        await init()
		reportLifecycle('init_ready')
        const pluginLifecycle = self.ensurePluginLifecycleLoaded()
        // Start native MCP discovery/connection alongside cold skill and
        // sandbox initialization. Only in-process SDK tools are awaited;
        // transport servers continue independently in the background.
        const mcpStartup = self.ensureMcpServersConnected()
        const skillsStartup = self.ensureSkillsLoaded()
        const sandboxStartup = self.ensureSandboxReady()
        await Promise.all([pluginLifecycle, mcpStartup, skillsStartup, sandboxStartup])
		reportLifecycle('runtime_ready')
        await self.ensureAgentsLoaded()
		reportLifecycle('agents_ready')

        // Switch session for transcript writes using session's own resolved dir
        switchSession(self._sessionId as SessionId, self._sessionProjectDir)

        try {
		  reportLifecycle('model_handoff')
          yield* self.runEngineTurn(content, options)
        } finally {
          self.agentFailureQueue.length = 0
        }
      })()
    })

    yield* inner
  }

  getMessages(): SDKMessage[] {
    return this.engine.getMessages().map(msg => mapMessageToSDK(msg as Record<string, unknown>))
  }

  unstable_syncMessages(messages: unknown[]): void {
    if (!Array.isArray(messages)) {
      throw new Error('SDKSessionImpl: messages must be an array')
    }
    this.replaceEngineWithInitialMessages(messages as any[])
  }

  async *retryMessage(parentUserMessageUuid: string): AsyncIterable<SDKMessage> {
    const sdkContext = {
      sessionId: this._sessionId as SessionId,
      sessionProjectDir: this._sessionProjectDir,
      cwd: this.options.cwd,
      originalCwd: this.options.cwd,
    }

    const self = this
    const inner = runSdkContextIterable(sdkContext, () => {
      return (async function* (): AsyncGenerator<SDKMessage> {
        await init()
        const retryPrompt = self.recreateEngineAtUserMessage(parentUserMessageUuid)
        const pluginLifecycle = self.ensurePluginLifecycleLoaded()
        const mcpStartup = self.ensureMcpServersConnected()
        const skillsStartup = self.ensureSkillsLoaded()
        const sandboxStartup = self.ensureSandboxReady()
        await Promise.all([pluginLifecycle, mcpStartup, skillsStartup, sandboxStartup])
        await self.ensureAgentsLoaded()
        switchSession(self._sessionId as SessionId, self._sessionProjectDir)
        try {
          yield* self.runEngineTurn(retryPrompt, { uuid: parentUserMessageUuid })
        } finally {
          self.agentFailureQueue.length = 0
        }
      })()
    })

    yield* inner
  }

  private recreateEngineAtUserMessage(parentUserMessageUuid: string): string | any[] {
    const parentUUID = parentUserMessageUuid.trim()
    if (!parentUUID) {
      throw new Error('SDKSessionImpl: retry parent user message UUID is required')
    }
    const messages = [...this.engine.getMessages()] as Array<Record<string, any>>
    const parentIndex = messages.findIndex(msg => msg.uuid === parentUUID)
    if (parentIndex < 0) {
      throw new Error(`SDKSessionImpl: retry parent user message ${parentUUID} was not found in session`)
    }
    const parentMessage = messages[parentIndex]
    if (parentMessage.type !== 'user' || parentMessage.toolUseResult || parentMessage.isMeta) {
      throw new Error(`SDKSessionImpl: retry parent message ${parentUUID} is not a selectable user message`)
    }
    const content = parentMessage.message?.content
    if (typeof content !== 'string' && !Array.isArray(content)) {
      throw new Error(`SDKSessionImpl: retry parent message ${parentUUID} has unsupported content`)
    }
    this.replaceEngineWithInitialMessages(messages.slice(0, parentIndex) as any[])
    return retryPromptContent(content)
  }

  private replaceEngineWithInitialMessages(messages: any[]): void {
    const signatureSafeMessages = stripSignatureBlocks(normalizeSDKSyncedMessages(messages))
    // Message synchronization, Retry, and Regenerate replace conversation
    // history, not the session-owned MCP lifecycle. Preserve the exact native
    // clients and already published tools just as the interactive InkUI engine
    // does across turns; reconnecting here dropped tools and restarted every
    // handshake before each warm request.
    const preservedMcpClients = [...(this._engine?.getMcpClients?.() ?? [])]
    const { engine, appStateStore, abortController, commands } = createEngineFromOptions(
      this.options,
      signatureSafeMessages,
      this._sessionId,
    )
    this._engine = engine
    this._appStateStore = appStateStore
    this._abortController = abortController
    this.commands = commands
    this.skillsLoaded = false
    this.pluginLifecycleLoaded = false
    this.agentsLoaded = false
    this.engine.setMcpClients(preservedMcpClients)
    this.applyPermissionContextFromOptions()
  }

  private hasRunningBackgroundTasks(): boolean {
    const state = this.appStateStore.getState()
    return getRunningTasks(state).some(
      task => isBackgroundTask(task) && task.type !== 'in_process_teammate',
    )
  }

  private shouldHoldResultForBackgroundTasks(): boolean {
    const state = this.appStateStore.getState()
    return getRunningTasks(state).some(
      task =>
        (task.type === 'local_agent' || task.type === 'local_workflow') &&
        isBackgroundTask(task),
    )
  }

  private async *runEngineTurn(
    content: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    let heldBackResult: SDKMessage | null = null
    for await (const engineMsg of this.engine.submitMessage(content, options)) {
      const sdkMessage = await hydrateToolProgressOutput(engineMsg)
      if (sdkMessage.type === 'result' && this.shouldHoldResultForBackgroundTasks()) {
        heldBackResult = sdkMessage
      } else {
        yield sdkMessage
      }
      yield* drainSdkEvents()
      yield* this.drainAgentFailureQueue()
    }
    yield* this.drainBackgroundTaskNotifications()
    yield* drainSdkEvents()
    yield* this.drainAgentFailureQueue()
    if (heldBackResult) {
      yield heldBackResult
    }
  }

  private async *drainBackgroundTaskNotifications(): AsyncGenerator<SDKMessage, void, unknown> {
    while (!this._abortController?.signal.aborted) {
      yield* drainSdkEvents()
      yield* this.drainAgentFailureQueue()

      const command = dequeue(isMainThreadTaskNotification)
      if (command) {
        const notification = sdkTaskNotificationFromQueuedCommand(command)
        if (notification) {
          yield notification
        }
        yield* this.runEngineTurn(command.value, {
          uuid: command.uuid,
          isMeta: command.isMeta,
        })
        continue
      }

      if (!this.hasRunningBackgroundTasks()) {
        return
      }
      await sleep(100, this._abortController?.signal, { unref: true })
    }
  }

  interrupt(): void {
    if (this._engine) {
      this._engine.interrupt()
    }
  }

  async stopTask(taskId: string): Promise<SDKStopTaskResult> {
    return await stopTask(taskId, {
      getAppState: () => this.appStateStore.getState(),
      setAppState: (f: (prev: AppState) => AppState) => this.appStateStore.setState(f),
    })
  }

  async generateSessionTitle(description: string): Promise<string | null> {
    const controller = this._abortController && !this._abortController.signal.aborted
      ? this._abortController
      : createAbortController()
    return titleOrNullForPromptFallback(
      await generateSourceSessionTitle(description, controller.signal),
    )
  }

  async sideQuestion(question: string): Promise<SDKSideQuestionResult> {
    const saved = getLastCacheSafeParams()
    if (!saved) {
      throw new Error('SDKSessionImpl: side_question cache context is unavailable until a turn completes')
    }
    const result = await runSourceSideQuestion({
      question,
      cacheSafeParams: {
        ...saved,
        toolUseContext: {
          ...saved.toolUseContext,
          abortController: createAbortController(),
        },
      },
    })
    return {
      response: result.response,
      usage: result.usage as unknown as Record<string, unknown>,
    }
  }

  private applyPermissionContextFromOptions(): void {
    const permissionContext = sdkVisiblePermissionContext(this.options)
    this.appStateStore.setState(prev => ({
      ...prev,
      toolPermissionContext: attachmentReadPermissionContext(permissionContext),
    }))
    this.engine.updateTools(mergeRuntimeTools(getTools(permissionContext), this.mcpTools))
  }

  private async ensureMcpServersConnected(): Promise<void> {
    if (this.mcpConnected) {
      return
    }
    if (this.mcpStartupPromise) {
      await this.mcpStartupPromise
      return
    }
    const generation = ++this.mcpConnectionGeneration
    const startup = this.startMcpServers(generation)
    this.mcpStartupPromise = startup
    try {
      await startup
    } finally {
      if (this.mcpStartupPromise === startup) {
        this.mcpStartupPromise = null
      }
    }
  }

  private async startMcpServers(generation: number): Promise<void> {
    try {
      // Host-provided SDK tools and persisted schemas are already the exact
      // turn-plan projection. Publish them before asking the filesystem plugin
      // loader to discover unrelated MCP configs. Interactive OpenClaude also
      // keeps plugin MCP discovery off the turn-one model barrier.
      const dynamicServers = this.mcpServers ?? {}
      const partitions = partitionSDKMcpServerConfigsForStartup(dynamicServers)
      // Persisted plugin schemas are a host projection of native plugin MCP,
      // not a second transport configuration. Do not give them dynamic-name
      // precedence or the native plugin loader would suppress the live server.
      const liveDynamicServers = {
        ...partitions.immediate,
        ...partitions.deferred,
      }
      const dynamicServerNames = new Set(Object.keys(liveDynamicServers))
      const immediate = { ...partitions.immediate }
      const deferred = { ...partitions.deferred }
      const persistedSchemaServers: string[] = []
      for (const [name, config] of Object.entries({
        ...deferred,
        ...partitions.pluginPersisted,
      })) {
        const projection = this.buildPersistedMcpProjection(name, config, generation)
        if (projection) {
          immediate[name] = projection
          persistedSchemaServers.push(name)
        }
      }
      if (bridgeDiagnosticsEnabled()) {
        console.warn(`SDK: MCP startup configs ${JSON.stringify({
          immediate: Object.keys(immediate).sort(),
          persisted_schema_servers: persistedSchemaServers.sort(),
          deferred: Object.entries(deferred)
            .map(([name, config]) => ({
              name,
              type: config && typeof config === 'object' && !Array.isArray(config)
                ? String((config as Record<string, unknown>).type ?? '')
                : typeof config,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        })}`)
      }
      await connectSDKMcpServersIncrementally(
        immediate,
        (name, config) => connectSdkMcpServers({ [name]: config }),
        (name, settlement) => this.publishMcpSettlement(name, settlement, generation, false),
      )
      if (generation !== this.mcpConnectionGeneration) {
        return
      }
      // Immediate SDK tools and persisted schemas are already local data.
      // Publish the complete turn-one tool pool once instead of rebuilding the
      // QueryEngine/AppState tool projection after every individual server.
      // Remote transports below still settle and publish independently.
      this.refreshPublishedMcpRuntime()
      this.mcpConnected = true
      for (const [name, config] of Object.entries(deferred)) {
        if (config === null || typeof config !== 'object' || Array.isArray(config)) {
          continue
        }
        this.mcpClientsByServer.set(name, [{
          type: 'pending',
          name,
          config: { ...(config as Record<string, unknown>), scope: 'session' },
        } as unknown as MCPServerConnection])
      }
      this.refreshPublishedMcpRuntime()
      // Host native transports outlive this startup call. Each server
      // publishes independently, so a slow connector delays only its actual
      // invocation and never the first outbound model request.
      void connectSDKMcpServersIncrementally(
        deferred,
        (name, config) => connectSdkMcpServers({ [name]: config }),
        (name, settlement) => {
          this.resolveNativeMcpWaiter(name, settlement, generation)
          this.publishMcpSettlement(name, settlement, generation)
        },
      )
      // Plugin MCP discovery can scan many manifests and resolve user config.
      // Run the native loader in the background and exclude dynamic names,
      // whose host-provided definitions have highest precedence and are
      // already live above.
      void this.startPluginMcpServers(generation, liveDynamicServers, dynamicServerNames)
    } catch (err) {
      console.warn('SDK: MCP server startup failed:', err instanceof Error ? err.message : String(err))
      if (generation === this.mcpConnectionGeneration) {
        this.failNativeMcpWaiters(err instanceof Error ? err : new Error(String(err)), generation)
        this.mcpConnected = true
      }
    }
  }

  private reportNativePluginMcpTools(
    serverName: string,
    settlement: { status: 'fulfilled'; value: { clients: MCPServerConnection[]; tools: Tool[] } } | { status: 'rejected'; reason: unknown },
    generation: number,
  ): void {
    const reporter = this.options.mcpToolReporter
    if (
      !reporter ||
      generation !== this.mcpConnectionGeneration ||
      settlement.status !== 'fulfilled' ||
      !serverName.startsWith('plugin:') ||
      !settlement.value.clients.some(client => client.type === 'connected')
    ) {
      return
    }
    const report = nativePluginMcpToolReport(serverName, settlement.value.tools)
    if (!report) {
      return
    }
    // Reporting is an observability/persistence side effect of an already
    // completed native tools/list. It must never delay or fail the model path.
    const publish = async (): Promise<void> => {
      const permissionContext = this.appStateStore.getState().toolPermissionContext
      const describedTools = await Promise.all(report.tools.map(async definition => {
        const native = settlement.value.tools.find(tool =>
          tool.mcpInfo?.serverName === serverName && tool.mcpInfo.toolName === definition.name,
        )
        if (!native) {
          return definition
        }
        try {
          const description = await native.description({} as never, {
            isNonInteractiveSession: true,
            toolPermissionContext: permissionContext,
            tools: settlement.value.tools,
          })
          return { ...definition, description }
        } catch {
          return definition
        }
      }))
      await reporter({ ...report, tools: describedTools })
    }
    void publish().catch(error => {
      if (bridgeDiagnosticsEnabled()) {
        console.warn(`SDK: plugin MCP schema reporter failed for ${serverName}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  private async startPluginMcpServers(
    generation: number,
    dynamicServers: Record<string, unknown>,
    dynamicServerNames: Set<string>,
  ): Promise<void> {
    try {
      // Native interactive startup loads the enabled plugin set before reading
      // plugin MCP configs. Preserve that ordering while the host SDK tools
      // continue to publish independently.
      await this.ensurePluginLifecycleLoaded()
      const resolved = await resolveSDKMcpServerConfigs(dynamicServers)
      if (generation !== this.mcpConnectionGeneration) {
        return
      }
      if (resolved.errors.length > 0) {
        console.warn(
          `SDK: native MCP/plugin config loading reported ${resolved.errors.length} error(s): ${JSON.stringify(resolved.errors)}`,
        )
      }
      const pluginServers = Object.fromEntries(
        Object.entries(resolved.servers).filter(([name]) => !dynamicServerNames.has(name)),
      )
      if (bridgeDiagnosticsEnabled()) {
        console.warn(`SDK: plugin MCP startup configs ${JSON.stringify({
          deferred: Object.entries(pluginServers)
            .map(([name, config]) => ({
              name,
              type: config && typeof config === 'object' && !Array.isArray(config)
                ? String((config as Record<string, unknown>).type ?? '')
                : typeof config,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        })}`)
      }
      for (const [name, config] of Object.entries(pluginServers)) {
        if (config === null || typeof config !== 'object' || Array.isArray(config)) {
          continue
        }
        this.mcpClientsByServer.set(name, [{
          type: 'pending',
          name,
          config: { ...(config as Record<string, unknown>), scope: 'session' },
        } as unknown as MCPServerConnection])
      }
      this.refreshPublishedMcpRuntime()
      await connectSDKMcpServersIncrementally(
        pluginServers,
        (name, config) => connectSdkMcpServers({ [name]: config }),
        (name, settlement) => {
          this.resolveNativeMcpWaiter(name, settlement, generation)
          this.publishMcpSettlement(name, settlement, generation)
          this.reportNativePluginMcpTools(name, settlement, generation)
        },
      )
    } catch (err) {
      if (generation === this.mcpConnectionGeneration) {
        console.warn('SDK: plugin MCP startup failed:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  private buildPersistedMcpProjection(
    serverName: string,
    config: unknown,
    generation: number,
  ): Record<string, unknown> | null {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return null
    }
    const persistedTools = (config as Record<string, unknown>).persistedTools
    if (persistedTools === undefined) {
      return null
    }
    if (!Array.isArray(persistedTools)) {
      throw new Error(`SDK: MCP server ${serverName} persistedTools must be an array`)
    }
    const waiter = this.createNativeMcpWaiter(serverName, generation)
    const definitions: SdkMcpToolDefinition[] = persistedTools.map((raw, index) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`SDK: MCP server ${serverName} persistedTools[${index}] must be an object`)
      }
      const definition = raw as Record<string, unknown>
      const upstreamName = typeof definition.name === 'string' ? definition.name.trim() : ''
      if (!upstreamName) {
        throw new Error(`SDK: MCP server ${serverName} persistedTools[${index}].name must be non-empty`)
      }
      const description = typeof definition.description === 'string' ? definition.description : ''
      const inputSchema = definition.inputSchema
      if (inputSchema === null || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
        throw new Error(`SDK: MCP server ${serverName} persistedTools[${index}].inputSchema must be an object`)
      }
      const qualifiedName = buildMcpToolName(serverName, upstreamName)
      const annotations = definition.annotations !== null && typeof definition.annotations === 'object' && !Array.isArray(definition.annotations)
        ? definition.annotations as ToolAnnotations
        : undefined
      const meta = definition._meta !== null && typeof definition._meta === 'object' && !Array.isArray(definition._meta)
        ? definition._meta as Record<string, unknown>
        : undefined
      return {
        name: qualifiedName,
        description,
        inputSchema: inputSchema as Record<string, unknown>,
        handler: (args, extra) => this.callPersistedMcpTool(
          serverName,
          upstreamName,
          qualifiedName,
          generation,
          waiter,
          args,
          extra,
        ),
        annotations,
        searchHint: typeof definition.searchHint === 'string' ? definition.searchHint : undefined,
        alwaysLoad: typeof definition.alwaysLoad === 'boolean' ? definition.alwaysLoad : undefined,
        _meta: meta,
        mcpInfo: { serverName, toolName: upstreamName },
      }
    })
    if (definitions.length === 0) {
      this.nativeMcpWaiters.delete(serverName)
      return null
    }
    return {
      type: 'sdk',
      name: `persisted:${serverName}`,
      tools: definitions,
    }
  }

  private createNativeMcpWaiter(serverName: string, generation: number): NativeMcpWaiter {
    let resolve!: (result: NativeMcpReadyResult) => void
    const promise = new Promise<NativeMcpReadyResult>(next => {
      resolve = next
    })
    const waiter = { generation, promise, resolve }
    this.nativeMcpWaiters.set(serverName, waiter)
    return waiter
  }

  private resolveNativeMcpWaiter(
    serverName: string,
    settlement: { status: 'fulfilled'; value: { clients: MCPServerConnection[]; tools: Tool[] } } | { status: 'rejected'; reason: unknown },
    generation: number,
  ): void {
    const waiter = this.nativeMcpWaiters.get(serverName)
    if (!waiter || waiter.generation !== generation) {
      return
    }
    this.nativeMcpWaiters.delete(serverName)
    if (settlement.status === 'rejected') {
      waiter.resolve({
        status: 'failed',
        error: settlement.reason instanceof Error ? settlement.reason : new Error(String(settlement.reason)),
      })
      return
    }
    const connected = settlement.value.clients.some(client => client.type === 'connected')
    if (!connected) {
      const failed = settlement.value.clients.find(client => client.type === 'failed')
      waiter.resolve({
        status: 'failed',
        error: new Error(failed?.error || `MCP server ${serverName} did not connect`),
      })
      return
    }
    waiter.resolve({ status: 'ready', tools: settlement.value.tools })
  }

  private async callPersistedMcpTool(
    serverName: string,
    upstreamName: string,
    qualifiedName: string,
    generation: number,
    waiter: NativeMcpWaiter,
    args: Record<string, unknown>,
    extra: unknown,
  ): Promise<CallToolResult> {
    if (generation !== this.mcpConnectionGeneration || waiter.generation !== generation) {
      throw new Error(`MCP server ${serverName} was reconfigured before ${upstreamName} could run`)
    }
    const invocation = extra && typeof extra === 'object'
      ? extra as Record<string, any>
      : {}
    const ready = await waitForNativeMcpReady(
      waiter.promise,
      invocation.context?.abortController?.signal,
      serverName,
      upstreamName,
    )
    if (ready.status === 'failed') {
      throw ready.error
    }
    const nativeTool = ready.tools.find(tool =>
      tool.name === qualifiedName ||
      (tool.mcpInfo?.serverName === serverName && tool.mcpInfo.toolName === upstreamName),
    )
    if (!nativeTool) {
      throw new Error(`MCP server ${serverName} did not publish persisted tool ${upstreamName}`)
    }
    const result = await nativeTool.call(
      args,
      invocation.context,
      undefined as never,
      invocation.parentMessage,
      invocation.onProgress,
    )
    return {
      content: result.data as CallToolResult['content'],
      ...(result.mcpMeta?._meta ? { _meta: result.mcpMeta._meta } : {}),
      ...(result.mcpMeta?.structuredContent
        ? { structuredContent: result.mcpMeta.structuredContent }
        : {}),
    }
  }

  private publishMcpSettlement(
    name: string,
    settlement: { status: 'fulfilled'; value: { clients: MCPServerConnection[]; tools: Tool[] } } | { status: 'rejected'; reason: unknown },
    generation: number,
    refreshRuntime = true,
  ): void {
    if (settlement.status === 'rejected') {
      if (generation === this.mcpConnectionGeneration) {
        console.warn(`SDK: MCP server ${name} failed:`, settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason))
      }
      return
    }
    if (generation !== this.mcpConnectionGeneration) {
      for (const client of settlement.value.clients) {
        if (client.type === 'connected' && client.cleanup) {
          void client.cleanup().catch(() => {})
        }
      }
      return
    }
    this.mcpClientsByServer.set(name, settlement.value.clients)
    this.mcpToolsByServer.set(name, settlement.value.tools)
    if (bridgeDiagnosticsEnabled()) {
      console.warn(`SDK: MCP server ${name} settled ${JSON.stringify({
        clients: settlement.value.clients.map(client => ({
          name: client.name,
          type: client.type,
          ...(client.type === 'failed' ? { error: client.error ?? '' } : {}),
        })),
        tools: settlement.value.tools.map(tool => tool.name).sort(),
      })}`)
    }
    if (settlement.value.tools.length > 0) {
      // Agent definitions validate their declared tools against the current
      // pool. Re-evaluate them on the next turn after late MCP tools arrive.
      this.agentsLoaded = false
    }
    if (refreshRuntime) {
      this.refreshPublishedMcpRuntime()
    }
  }

  private refreshPublishedMcpRuntime(): void {
    const clients = [...this.mcpClientsByServer.values()].flat()
    this.mcpTools = [...this.mcpToolsByServer.values()].flat()
    this.engine.setMcpClients(clients)
    this.appStateStore.setState(prev => ({
      ...prev,
      mcp: assembleSDKMcpAppState(
        prev.mcp,
        this.mcpClientsByServer,
        this.mcpToolsByServer,
      ),
    }))
    this.applyPermissionContextFromOptions()
  }

  private disconnectMcpClients(reason: string): void {
    const disconnectedGeneration = this.mcpConnectionGeneration
    this.mcpConnectionGeneration += 1
    this.mcpStartupPromise = null
    this.failNativeMcpWaiters(new Error(`MCP connections were reset during ${reason}`), disconnectedGeneration)
    const mcpClients = this._engine?.getMcpClients?.() ?? []
    for (const client of mcpClients) {
      if (client.type === 'connected' && client.cleanup) {
        void client.cleanup().catch(err => {
          console.warn(`SDK: MCP client cleanup error during ${reason}:`, err instanceof Error ? err.message : String(err))
        })
      }
    }
    this._engine?.setMcpClients?.([])
    this.mcpClientsByServer.clear()
    this.mcpToolsByServer.clear()
    if (this._engine && this._appStateStore) {
      this.refreshPublishedMcpRuntime()
    }
  }

  private failNativeMcpWaiters(error: Error, generation?: number): void {
    for (const [serverName, waiter] of this.nativeMcpWaiters) {
      if (generation !== undefined && waiter.generation !== generation) {
        continue
      }
      this.nativeMcpWaiters.delete(serverName)
      waiter.resolve({ status: 'failed', error })
    }
  }

  close(): void {
    this.interrupt()
    this.mcpConnectionGeneration += 1
    this.mcpStartupPromise = null
    this.failNativeMcpWaiters(new Error('SDK session closed'))
    // Abort the AbortController to cancel any in-flight HTTP requests or
    // async operations tied to the signal. Mirrors QueryImpl.close().
    this._abortController?.abort()
    this._abortController = null
    // Disconnect MCP clients to prevent resource leaks
    const mcpClients = this._engine?.getMcpClients?.() ?? []
    for (const client of mcpClients) {
      if (client.type === 'connected' && client.cleanup) {
        // Fire-and-forget cleanup — close() is synchronous
        void client.cleanup().catch(err => {
          console.warn('SDK: MCP client cleanup error:', err instanceof Error ? err.message : String(err))
        })
      }
    }
    // Clear engine and store references to prevent memory leaks
    this._engine = null
    this._appStateStore = null
    this.mcpTools = []
  }

  /** Push an agent load failure message into the queue for later draining. */
  pushAgentFailure(msg: SDKAgentLoadFailureMessage): void {
    this.agentFailureQueue.push(msg)
  }

  /** Drain all queued agent failure messages. */
  private *drainAgentFailureQueue(): Generator<SDKAgentLoadFailureMessage> {
    while (this.agentFailureQueue.length > 0) {
      yield this.agentFailureQueue.shift()!
    }
  }

}

function isMainThreadTaskNotification(command: QueuedCommand): boolean {
  return command.mode === 'task-notification' && command.agentId === undefined
}

function sdkTaskNotificationFromQueuedCommand(command: QueuedCommand): SDKMessage | null {
  const text = typeof command.value === 'string' ? command.value : ''
  if (!text.includes(`<${TASK_NOTIFICATION_TAG}`)) {
    return null
  }
  const status = normalizeTaskNotificationStatus(extractXmlTag(text, STATUS_TAG))
  if (!status) {
    return null
  }
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: extractXmlTag(text, TASK_ID_TAG) ?? '',
    tool_use_id: extractXmlTag(text, TOOL_USE_ID_TAG) ?? undefined,
    status,
    output_file: extractXmlTag(text, OUTPUT_FILE_TAG) ?? '',
    summary: extractXmlTag(text, SUMMARY_TAG) ?? '',
    uuid: randomUUID(),
    session_id: getSessionId(),
  } as SDKMessage
}

function normalizeTaskNotificationStatus(status: string | null): 'completed' | 'failed' | 'stopped' | null {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'stopped':
      return status
    case 'killed':
      return 'stopped'
    default:
      return null
  }
}

function extractXmlTag(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match?.[1] ?? null
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function normalizeOptionalSessionString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`)
  }
  const text = value.trim()
  if (!text) {
    throw new Error(`${name} must not be empty`)
  }
  return text
}

function normalizeThinkingConfig(value: unknown): ThinkingConfig | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SDKSession.updateOptions.thinkingConfig must be an object')
  }
  const config = value as Record<string, unknown>
  const type = config.type
  if (type === 'adaptive' || type === 'disabled') {
    return { type }
  }
  if (type === 'enabled') {
    const budgetTokens = config.budgetTokens
    if (typeof budgetTokens !== 'number' || !Number.isFinite(budgetTokens) || budgetTokens <= 0) {
      throw new Error('SDKSession.updateOptions.thinkingConfig.budgetTokens must be a positive number')
    }
    return { type, budgetTokens }
  }
  throw new Error('SDKSession.updateOptions.thinkingConfig.type must be adaptive, enabled, or disabled')
}

function mergeRuntimeTools(
  builtinTools: readonly Tool[],
  mcpTools: readonly Tool[],
): Tool[] {
  const merged = [...builtinTools]
  for (const tool of mcpTools) {
    if (!merged.some(existing => existing.name === tool.name)) {
      merged.push(tool)
    }
  }
  return merged
}

async function waitForNativeMcpReady(
  promise: Promise<NativeMcpReadyResult>,
  signal: AbortSignal | undefined,
  serverName: string,
  toolName: string,
): Promise<NativeMcpReadyResult> {
  if (!signal) {
    return await promise
  }
  const abortError = () => {
    const error = new Error(`MCP tool ${serverName}.${toolName} was interrupted before transport startup completed`)
    error.name = 'AbortError'
    return error
  }
  if (signal.aborted) {
    throw abortError()
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(abortError())
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function retryPromptContent(content: string | any[]): string | any[] {
  if (typeof content === 'string') {
    return content
  }
  if (content.every(block => block?.type === 'text' && typeof block.text === 'string')) {
    return content.map(block => block.text).join('')
  }
  return content
}

// ============================================================================
// createEngineFromOptions
// ============================================================================

/**
 * Shared helper that builds a QueryEngine and its supporting state from
 * SDKSessionOptions. Used by both createSession and resumeSession.
 */
function createEngineFromOptions(
  options: SDKSessionOptions,
  initialMessages?: any[],
  sessionId?: string,
): { engine: QueryEngine; appStateStore: Store<AppState>; abortController: AbortController; commands: Command[] } {
  const { cwd, model, abortController, permissionMode } = options

  if (!cwd) {
    throw new Error('SDKSessionOptions requires cwd')
  }
  applySDKLocalPlugins(options.plugins)
  installFileReadAttachmentSupplementalContent()
  installBridgeDiagnostics()
  configureSessionEventStore(options)
  applySessionSettingSources(options.settingSources)
  applySessionFlagSettings(options.settings)
  setProjectRoot(cwd)

  // NOTE: cwd is NOT set on global state here. SDKSessionImpl.sendMessage()
  // sets/restores it per-message via the cwd mutex to prevent concurrent
  // sessions from overwriting each other's working directory.

  // Build permission context
  const permissionContext = sdkVisiblePermissionContext(options)

  // Create AppState store (minimal, headless)
  const initialAppState = getDefaultAppState()
  const stateWithPermissions = {
    ...initialAppState,
    toolPermissionContext: attachmentReadPermissionContext(permissionContext),
  }
  if (model) {
    stateWithPermissions.mainLoopModel = model
    stateWithPermissions.mainLoopModelForSession = model
  }
  const appStateStore = createStore<AppState>(stateWithPermissions)
  registerSDKSessionFunctionHooks(options, appStateStore, sessionId)

  // Build thinkingConfig from initial state
  // thinkingEnabled defaults to true via getDefaultAppState() -> shouldEnableThinkingByDefault()
  // Explicit false disables thinking, undefined defaults to enabled (adaptive mode)
  const thinkingEnabled = stateWithPermissions.thinkingEnabled ?? true
  const thinkingConfig = options.thinkingConfig ?? (thinkingEnabled
    ? (stateWithPermissions.thinkingBudgetTokens
      ? { type: 'enabled' as const, budgetTokens: stateWithPermissions.thinkingBudgetTokens }
      : { type: 'adaptive' as const })
    : { type: 'disabled' as const })

  // Get tools filtered by permission context
  const tools = getTools(permissionContext)

  // Create file state cache
  const readFileCache = createFileStateCacheWithSizeLimit(100)

  // Build the canUseTool wrapper. Source permission checks run first; host
  // canUseTool is only asked when the source engine returns ask.
  const defaultCanUseTool = createDefaultCanUseTool(permissionContext)
  const canUseTool = createExternalCanUseTool(
    options.canUseTool ?? undefined,
    defaultCanUseTool,
  )

  let customSystemPrompt: string | undefined
  let appendSystemPrompt: string | undefined
  if (typeof options.systemPrompt === 'string') {
    customSystemPrompt = options.systemPrompt
  } else if (options.systemPrompt?.type === 'custom') {
    customSystemPrompt = options.systemPrompt.content
  } else if (options.systemPrompt?.type === 'preset' && options.systemPrompt.append) {
    appendSystemPrompt = options.systemPrompt.append
  }
  if (typeof options.appendSystemPrompt === 'string' && options.appendSystemPrompt.trim()) {
    appendSystemPrompt = appendSystemPrompt
      ? `${appendSystemPrompt}\n\n${options.appendSystemPrompt}`
      : options.appendSystemPrompt
  }

  // Abort controller
  const ac = abortController ?? new AbortController()

  // Create QueryEngine config
  const commands: Command[] = []
  const engineConfig = {
    cwd,
    tools,
    commands,
    mcpClients: [],
    agents: [],
    canUseTool,
    getAppState: () => appStateStore.getState(),
    setAppState: (f: (prev: AppState) => AppState) => appStateStore.setState(f),
    readFileCache,
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel: model,
    abortController: ac,
    thinkingConfig,
    maxOutputTokensOverride: options.maxOutputTokens,
    temperatureOverride: options.temperature,
    maxTurns: options.maxTurns,
    providerOverride: options.providerOverride,
    persistSession: options.persistSession,
    replayUserMessages: options.replayUserMessages ?? false,
    includePartialMessages: options.includePartialMessages ?? false,
    ...(initialMessages ? { initialMessages } : {}),
  }

  const engine = new QueryEngine(engineConfig)

  return { engine, appStateStore, abortController: ac, commands }
}

function normalizeSDKSyncedMessages(messages: any[]): any[] {
  let changed = false
  const next = messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'assistant') {
      return message
    }
    const content = message.message?.content
    if (!Array.isArray(content)) {
      return message
    }
    const normalizedContent = normalizeSDKSyncedAssistantContent(content)
    if (normalizedContent === content) {
      return message
    }
    changed = true
    return {
      ...message,
      message: {
        ...message.message,
        content: normalizedContent,
      },
    }
  })
  return changed ? next : messages
}

function normalizeSDKSyncedAssistantContent(content: any[]): any[] {
  let changed = false
  const normalized: any[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      normalized.push(block)
      continue
    }
    if (block.type !== 'tool_use') {
      normalized.push(block)
      continue
    }
    const toolUse = normalizeSDKSyncedToolUseBlock(block)
    if (!toolUse) {
      changed = true
      break
    }
    if (toolUse !== block) {
      changed = true
    }
    normalized.push(toolUse)
  }
  return changed ? normalized : content
}

function normalizeSDKSyncedToolUseBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  const id = typeof block.id === 'string' && block.id.trim() ? block.id : ''
  const name = typeof block.name === 'string' && block.name.trim() ? block.name : ''
  if (!id || !name) {
    return null
  }
  const input = sdkSyncedToolUseInputObject(block)
  if (!input) {
    return null
  }
  if (block.input === input && !('partial_json' in block) && !('buffered_input' in block) && !('partial_input' in block)) {
    return block
  }
  const normalized: Record<string, unknown> = {
    ...block,
    type: 'tool_use',
    id,
    name,
    input,
  }
  delete normalized.partial_json
  delete normalized.buffered_input
  delete normalized.partial_input
  return normalized
}

function sdkSyncedToolUseInputObject(block: Record<string, unknown>): Record<string, unknown> | null {
  const direct = plainRecordOrNull(block.input)
  if (direct) {
    return direct
  }
  const toolInput = plainRecordOrNull(block.tool_input) ?? parsePlainRecordOrNull(block.tool_input)
  if (toolInput) {
    return toolInput
  }
  for (const key of ['buffered_input', 'partial_json', 'partial_input']) {
    const parsed = parsePlainRecordOrNull(block[key])
    if (parsed) {
      return parsed
    }
  }
  return null
}

function parsePlainRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  try {
    return plainRecordOrNull(JSON.parse(value))
  } catch {
    return null
  }
}

function plainRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function registerSDKSessionFunctionHooks(
  options: SDKSessionOptions,
  appStateStore: Store<AppState>,
  sessionId?: string,
): void {
  if (!sessionId || !options.hooks) {
    return
  }
  for (const [eventName, hooks] of Object.entries(options.hooks) as Array<[HookEvent, SDKSessionFunctionHook[] | undefined]>) {
    if (!Array.isArray(hooks)) {
      continue
    }
    for (const hook of hooks) {
      if (!hook || typeof hook.callback !== 'function') {
        continue
      }
      addFunctionHook(
        (updater: (prev: AppState) => AppState) => appStateStore.setState(updater),
        sessionId,
        eventName,
        hook.matcher ?? '',
        (messages, signal) => hook.callback(messages as unknown[], signal),
        hook.errorMessage ?? 'SDK session hook failed',
        {
          id: hook.id,
          timeout: hook.timeout,
        },
      )
    }
  }
}

function attachmentReadPermissionContext(
  permissionContext: ToolPermissionContext,
): ToolPermissionContext {
  const cliDenyRules = permissionContext.alwaysDenyRules.cliArg ?? []
  const nextCliDenyRules = cliDenyRules.filter(
    rule => rule.trim() !== FILE_READ_TOOL_NAME,
  )
  if (nextCliDenyRules.length === cliDenyRules.length) {
    return permissionContext
  }
  return {
    ...permissionContext,
    alwaysDenyRules: {
      ...permissionContext.alwaysDenyRules,
      cliArg: nextCliDenyRules,
    },
  }
}

function sdkVisiblePermissionContext(options: SDKSessionOptions): ToolPermissionContext {
  return applyBuiltinToolsFilter(buildPermissionContext({
    cwd: options.cwd,
    permissionMode: options.permissionMode,
    additionalDirectories: options.additionalDirectories,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
  }), options.tools, getToolsForDefaultPreset())
}

function applySessionFlagSettings(settings?: Record<string, unknown>): void {
  if (!settings || Object.keys(settings).length === 0) {
    return
  }
  setFlagSettingsInline(settings)
  settingsChangeDetector.notifyChange('flagSettings')
}

function applySessionSettingSources(settingSources?: string[]): void {
  if (!settingSources) {
    return
  }
  setAllowedSettingSources(parseSettingSourcesFlag(settingSources.join(',')))
  settingsChangeDetector.notifyChange('userSettings')
  settingsChangeDetector.notifyChange('projectSettings')
  settingsChangeDetector.notifyChange('localSettings')
}

// ============================================================================
// V2 API Functions
// ============================================================================

/**
 * V2 API - UNSTABLE
 * Creates a persistent SDKSession wrapping a QueryEngine for multi-turn
 * conversations.
 *
 * @alpha
 *
 * @example
 * ```typescript
 * const session = unstable_v2_createSession({ cwd: '/my/project' })
 * for await (const msg of session.sendMessage('Hello!')) {
 *   console.log(msg)
 * }
 * // Continue the conversation:
 * for await (const msg of session.sendMessage('What did I just say?')) {
 *   console.log(msg)
 * }
 * ```
 */
export function unstable_v2_createSession(options: SDKSessionOptions): SDKSession {
  const sessionId = randomUUID()
  configureSessionEventStore(options)
  const session = new SDKSessionImpl(null, sessionId, options, null)
  const { engine, appStateStore, abortController, commands } = createEngineFromOptions(options, undefined, sessionId)
  // Wire the engine, store, and abort controller into the session
  session.setEngine(engine)
  session.setAppStateStore(appStateStore)
  session.setAbortController(abortController)
  session.setCommands(commands)
  session.startBackgroundRuntime()
  return session
}

/**
 * V2 API - UNSTABLE
 * Resume an existing session by ID. Loads the session's prior messages
 * from disk and passes them to the QueryEngine so the conversation
 * continues from where it left off.
 *
 * @alpha
 *
 * @param sessionId - UUID of the session to resume
 * @param options - Session options (cwd is required)
 * @returns SDKSession with prior conversation history loaded
 *
 * @example
 * ```typescript
 * const session = await unstable_v2_resumeSession(sessionId, { cwd: '/my/project' })
 * for await (const msg of session.sendMessage('Continue where we left off')) {
 *   console.log(msg)
 * }
 * ```
 */
export async function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions,
): Promise<SDKSession> {
  assertValidSessionId(sessionId)
  const sessionCwd = await canonicalizePath(options.cwd)
  const sessionProjectDir = getProjectDir(sessionCwd)
  const sessionOptions = { ...options, cwd: sessionCwd }
  configureSessionEventStore(sessionOptions)
  if (sessionOptions.sessionEventReader) {
    await runWithSdkContext(
      {
        sessionId: sessionId as SessionId,
        sessionProjectDir,
        cwd: sessionCwd,
        originalCwd: sessionCwd,
      },
      () => hydrateFromCCRv2InternalEvents(sessionId),
    )
  }

  // Load prior messages from JSONL with compact-aware chain building.
  // Matches CLI's loadTranscriptFile → buildConversationChain → removeExtraFields.
  const resolved = await resolveSessionFilePath(sessionId, sessionCwd)
  let initialMessages: any[]

  if (resolved) {
    const { size: fileSize } = await stat(resolved.filePath)
    let entries: JsonlEntry[]
    let preservedSegment: { headUuid: string; tailUuid: string; anchorUuid: string } | null = null
    let boundaryIndex = -1

    if (fileSize > SKIP_PRECOMPACT_THRESHOLD) {
      const scan = await readTranscriptForLoad(resolved.filePath, fileSize)
      entries = parseJsonlEntries(scan.postBoundaryBuf.toString('utf8'))
      const boundary = findLastCompactBoundary(entries)
      preservedSegment = boundary.preservedSegment
      boundaryIndex = boundary.index
    } else {
      entries = await readJSONLFile<JsonlEntry>(resolved.filePath)
      const boundary = findLastCompactBoundary(entries)
      preservedSegment = boundary.preservedSegment
      boundaryIndex = boundary.index
    }

    // Step 1: Index ALL non-sidechain entries by UUID (user, assistant, system, etc.)
    // CLI indexes all transcript-chain entries — we need system compact_boundary
    // entries for cases where anchorUuid === boundary.uuid
    type ChainEntry = JsonlEntry & { parentUuid?: string | null }
    const byUuid = new Map<string, ChainEntry>()
    for (const entry of entries) {
      if (entry.isSidechain) continue
      if (entry.uuid) byUuid.set(entry.uuid, entry as ChainEntry)
    }

    // Apply preserved segment relinks
    let preservedUuids = new Set<string>()
    if (preservedSegment) {
      preservedUuids = applyPreservedSegmentRelinks(byUuid, preservedSegment)
    }

    // Prune pre-boundary entries (keep preserved + post-boundary)
    if (boundaryIndex >= 0 && !preservedSegment) {
      const postBoundaryUuids = new Set<string>()
      for (const entry of entries.slice(boundaryIndex + 1)) {
        if (entry.uuid && !entry.isSidechain) postBoundaryUuids.add(entry.uuid)
      }
      for (const uuid of byUuid.keys()) {
        if (!postBoundaryUuids.has(uuid)) byUuid.delete(uuid)
      }
    } else if (boundaryIndex >= 0 && preservedSegment && preservedUuids.size > 0) {
      const postBoundaryUuids = new Set<string>()
      for (const entry of entries.slice(boundaryIndex + 1)) {
        if (entry.uuid && !entry.isSidechain) postBoundaryUuids.add(entry.uuid)
      }
      // Keep: preserved entries + anchor + post-boundary entries
      // The anchor is needed because preserved head.parentUuid = anchor after relink
      const anchorUuid = preservedSegment.anchorUuid
      for (const uuid of byUuid.keys()) {
        if (!preservedUuids.has(uuid) && !postBoundaryUuids.has(uuid) && uuid !== anchorUuid) {
          byUuid.delete(uuid)
        }
      }
    } else if (boundaryIndex >= 0 && preservedSegment && preservedUuids.size === 0) {
      const postBoundaryUuids = new Set<string>()
      for (const entry of entries.slice(boundaryIndex + 1)) {
        if (entry.uuid && !entry.isSidechain) postBoundaryUuids.add(entry.uuid)
      }
      for (const uuid of byUuid.keys()) {
        if (!postBoundaryUuids.has(uuid)) byUuid.delete(uuid)
      }
    }

    if (byUuid.size > 0) {
      const parentUuids = new Set<string>()
      for (const e of byUuid.values()) {
        if (e.parentUuid) parentUuids.add(e.parentUuid)
      }
      let leaf: ChainEntry | undefined
      let bestTs = -1
      for (const e of byUuid.values()) {
        // Step 2: Only user/assistant entries can be conversation leaves
        // System entries (compact_boundary, etc.) are part of the chain but not leaves
        if (e.type !== 'user' && e.type !== 'assistant') continue
        if (parentUuids.has(e.uuid!)) continue
        const ts = e.timestamp ? new Date(e.timestamp as string).getTime() : 0
        if (ts >= bestTs) { bestTs = ts; leaf = e }
      }
      if (leaf) {
        const chain = buildChain(byUuid, leaf)
        initialMessages = stripChainFields(chain)
      } else {
        initialMessages = []
      }
    } else {
      initialMessages = []
    }
  } else {
    initialMessages = []
  }

  const session = new SDKSessionImpl(null, sessionId, sessionOptions, null)
  const signatureSafeInitialMessages = stripSignatureBlocks(normalizeSDKSyncedMessages(initialMessages))
  const { engine, appStateStore, abortController, commands } = createEngineFromOptions(
    sessionOptions,
    signatureSafeInitialMessages as any[],
    sessionId,
  )
  session.setEngine(engine)
  session.setAppStateStore(appStateStore)
  session.setAbortController(abortController)
  session.setCommands(commands)

  // Store the resolved transcript directory for correct routing in sendMessage()
  // and set global state so tests and legacy code can verify the routing.
  if (resolved) {
    const transcriptDir = dirname(resolved.filePath)
    session.setSessionProjectDir(transcriptDir)
    switchSession(sessionId as SessionId, transcriptDir)
  }

  session.startBackgroundRuntime()

  return session
}

type BridgeDiagnosticsGlobal = typeof globalThis & {
  __openClaudeBridgeDiagnosticsInstalled?: boolean
  __openClaudeSDKAttachmentSupplementalWrapped?: boolean
  __openClaudeBridgeDiagnosticsFetchWrapped?: boolean
  __openClaudeSDKAttachmentSupplementalBlocks?: ContentBlockParam[]
}

type ApiMediaSummary = {
  text_blocks: number
  image_blocks: number
  document_blocks: number
  pdf_document_blocks: number
  tool_use_blocks: number
  tool_result_blocks: number
  tool_use_names: string[]
  tool_result_names: string[]
  image_media_types: string[]
  document_media_types: string[]
}

function installBridgeDiagnostics(): void {
  if (!bridgeDiagnosticsEnabled()) {
    return
  }
  const root = globalThis as BridgeDiagnosticsGlobal
  if (root.__openClaudeBridgeDiagnosticsInstalled) {
    return
  }
  root.__openClaudeBridgeDiagnosticsInstalled = true
  installFetchBridgeDiagnostics(root)
}

function installFileReadAttachmentSupplementalContent(): void {
  const root = globalThis as BridgeDiagnosticsGlobal
  if (root.__openClaudeSDKAttachmentSupplementalWrapped) {
    return
  }
  root.__openClaudeSDKAttachmentSupplementalWrapped = true
  const originalCall = FileReadTool.call.bind(FileReadTool)
  FileReadTool.call = (async (input: unknown, context: unknown) => {
    const startedAt = Date.now()
    try {
      const result = await originalCall(input as never, context as never)
      queueFileReadSupplementalBlocks(result)
      emitBridgeDiagnostic('file_read_tool_call', {
        ok: true,
        duration_ms: Date.now() - startedAt,
        input: fileReadInputSummary(input),
        result: fileReadResultSummary(result),
      })
      return result
    } catch (error) {
      emitBridgeDiagnostic('file_read_tool_call', {
        ok: false,
        duration_ms: Date.now() - startedAt,
        input: fileReadInputSummary(input),
        error: errorSummary(error),
      })
      throw error
    }
  }) as typeof FileReadTool.call
}

function installFetchBridgeDiagnostics(root: BridgeDiagnosticsGlobal): void {
  if (root.__openClaudeBridgeDiagnosticsFetchWrapped || typeof globalThis.fetch !== 'function') {
    return
  }
  root.__openClaudeBridgeDiagnosticsFetchWrapped = true
  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const rewritten = await maybeAttachQueuedSupplementalBlocks(input, init)
    try {
      await emitApiRequestMediaDiagnostic(rewritten.input, rewritten.init)
    } catch {
      // Diagnostics must never affect the SDK request path.
    }
    return originalFetch(rewritten.input, rewritten.init)
  }) as typeof fetch
}

function queueFileReadSupplementalBlocks(result: unknown): void {
  const blocks = supplementalBlocksFromNewMessages((result as { newMessages?: unknown[] })?.newMessages)
  if (blocks.length === 0) {
    return
  }
  const root = globalThis as BridgeDiagnosticsGlobal
  root.__openClaudeSDKAttachmentSupplementalBlocks = [
    ...(root.__openClaudeSDKAttachmentSupplementalBlocks ?? []),
    ...blocks,
  ]
}

async function maybeAttachQueuedSupplementalBlocks(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<{ input: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] }> {
  const root = globalThis as BridgeDiagnosticsGlobal
  const queued = root.__openClaudeSDKAttachmentSupplementalBlocks ?? []
  if (queued.length === 0 || !requestURL(input).includes('/messages')) {
    return { input, init }
  }
  const bodyText = await requestBodyText(input, init)
  if (!bodyText) {
    return { input, init }
  }
  const body = JSON.parse(bodyText) as Record<string, unknown>
  const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : []
  if (messages.length === 0 || summarizeApiMessages(messages).document_blocks > 0) {
    return { input, init }
  }
  const target = [...messages].reverse().find(message => message.role === 'user') ?? messages[messages.length - 1]
  if (!target) {
    return { input, init }
  }
  const existingContent = target.content
  target.content = [
    ...(typeof existingContent === 'string'
      ? [{ type: 'text' as const, text: existingContent }]
      : Array.isArray(existingContent)
        ? existingContent
        : []),
    ...queued,
  ]
  root.__openClaudeSDKAttachmentSupplementalBlocks = []
  const nextInit = init ? { ...init, body: JSON.stringify(body) } : init
  emitBridgeDiagnostic('api_request_media_supplemental_attached', {
    queued_blocks: queued.length,
    queued_block_types: queued.map(block => typeof block === 'object' && block !== null ? (block as { type?: unknown }).type : ''),
  })
  return { input, init: nextInit }
}

function supplementalBlocksFromNewMessages(messages: unknown): ContentBlockParam[] {
  if (!Array.isArray(messages)) {
    return []
  }
  const blocks: ContentBlockParam[] = []
  for (const message of messages) {
    const content = (message as { message?: { content?: unknown }; content?: unknown })?.message?.content ??
      (message as { content?: unknown })?.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      if (isSupplementalFileBlock(block)) {
        blocks.push(block)
      }
    }
  }
  return blocks
}

function isSupplementalFileBlock(block: unknown): block is ContentBlockParam {
  if (!block || typeof block !== 'object') {
    return false
  }
  const type = (block as { type?: unknown }).type
  return type === 'document'
}

async function emitApiRequestMediaDiagnostic(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<void> {
  const url = requestURL(input)
  if (!url.includes('/messages')) {
    return
  }
  const bodyText = await requestBodyText(input, init)
  if (!bodyText) {
    return
  }
  const body = JSON.parse(bodyText) as Record<string, unknown>
  const messages = Array.isArray(body.messages) ? body.messages : []
  const systemText = apiRequestTextFragments(body.system).join('\n')
  const skillListing = extractApiSkillListingEvidence(body.system, messages)
  const requestToolNames = (Array.isArray(body.tools) ? body.tools : [])
    .map(apiRequestToolName)
    .filter((name): name is string => name !== '')
  emitBridgeDiagnostic('api_request_media', {
    url_kind: apiURLKind(url),
    model: typeof body.model === 'string' ? body.model : '',
    message_count: messages.length,
    media: summarizeApiMessages(messages),
  })
  emitBridgeDiagnostic('api_request_prompt_contract', {
    url_kind: apiURLKind(url),
    model: typeof body.model === 'string' ? body.model : '',
    system_prompt_chars: systemText.length,
    system_prompt_sha256: createHash('sha256').update(systemText).digest('hex'),
    skill_listing_sources: skillListing.sources,
    skill_listing_entries: skillListing.entries,
    skill_listing_names: skillListing.names,
    skill_listing_count: skillListing.names.length,
    request_tool_names: requestToolNames,
    request_tool_count: requestToolNames.length,
    mcp_tool_names: requestToolNames.filter(name => name.startsWith('mcp__')),
    has_skill_tool: requestToolNames.includes('Skill'),
    has_tool_search: requestToolNames.includes('ToolSearch'),
  })
}

function apiRequestToolName(tool: unknown): string {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return ''
  }
  const record = tool as { name?: unknown; function?: { name?: unknown } }
  if (typeof record.name === 'string') {
    return record.name
  }
  return typeof record.function?.name === 'string' ? record.function.name : ''
}

function apiRequestTextFragments(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap(item => {
    if (typeof item === 'string') {
      return [item]
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return []
    }
    const text = (item as { text?: unknown }).text
    return typeof text === 'string' ? [text] : []
  })
}

function extractApiSkillListingEvidence(
  system: unknown,
  messages: unknown[],
): { sources: string[]; entries: string[]; names: string[] } {
  const marker = 'The following skills are available for use with the Skill tool:'
  const sources = new Set<string>()
  const entries = new Set<string>()
  const names = new Set<string>()
  const candidates = [
    { source: 'system', text: apiRequestTextFragments(system).join('\n') },
    ...messages.map((message, index) => ({
      source: `messages[${index}].content`,
      text: apiRequestTextFragments((message as { content?: unknown })?.content).join('\n'),
    })),
  ]
  for (const { source, text } of candidates) {
    let searchFrom = 0
    while (searchFrom < text.length) {
      const markerIndex = text.indexOf(marker, searchFrom)
      if (markerIndex < 0) {
        break
      }
      const lines = text.slice(markerIndex + marker.length).split('\n')
      let listingStarted = false
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          if (listingStarted) break
          continue
        }
        if (!trimmed.startsWith('- ')) {
          if (listingStarted) break
          continue
        }
        listingStarted = true
        const entry = trimmed.slice(2)
        sources.add(source)
        entries.add(entry)
        const descriptionIndex = entry.indexOf(': ')
        const name = (descriptionIndex >= 0 ? entry.slice(0, descriptionIndex) : entry).trim()
        if (name) names.add(name)
      }
      searchFrom = markerIndex + marker.length
    }
  }
  return {
    sources: [...sources].sort(),
    entries: [...entries].sort(),
    names: [...names].sort(),
  }
}

function bridgeDiagnosticsEnabled(): boolean {
  return process.env.OPENCLAUDE_BRIDGE_ACTOR_MODE === '1' &&
    (process.env.DEBUG_SDK === '1' || process.env.CLAUDE_CODE_DEBUG_LOG_LEVEL === 'debug')
}

function emitBridgeDiagnostic(stage: string, details: Record<string, unknown>): void {
  if (!bridgeDiagnosticsEnabled()) {
    return
  }
  process.stdout.write(`${JSON.stringify({
    runtime_adapter_event: 'sdk_diagnostic',
    stage,
    openclaude_session_id: getSessionId(),
    details,
  })}\n`)
}

function fileReadInputSummary(input: unknown): Record<string, unknown> {
  const filePath = typeof input === 'object' && input !== null && typeof (input as { file_path?: unknown }).file_path === 'string'
    ? (input as { file_path: string }).file_path
    : ''
  return {
    tool_name: FILE_READ_TOOL_NAME,
    file_name: filePath ? basename(filePath) : '',
    extension: filePath ? extname(filePath).toLowerCase() : '',
    is_upload_path: filePath.includes('/mnt/user-data/uploads/'),
  }
}

function fileReadResultSummary(result: unknown): Record<string, unknown> {
  const value = result as {
    data?: { type?: unknown; media_type?: unknown; file?: { file_name?: unknown; file_size?: unknown } }
    resultForAssistant?: { data?: { type?: unknown; media_type?: unknown } }
    newMessages?: unknown[]
  }
  const data = value?.data ?? value?.resultForAssistant?.data
  const dataRecord = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const fileRecord = dataRecord.file && typeof dataRecord.file === 'object'
    ? dataRecord.file as Record<string, unknown>
    : {}
  return {
    data_type: typeof data?.type === 'string' ? data.type : '',
    media_type: typeof data?.media_type === 'string' ? data.media_type : '',
    has_new_messages: Array.isArray(value?.newMessages) && value.newMessages.length > 0,
    new_message_count: Array.isArray(value?.newMessages) ? value.newMessages.length : 0,
    new_message_block_types: newMessageBlockTypes(value?.newMessages),
    file_name: typeof fileRecord.file_name === 'string' ? fileRecord.file_name : '',
    file_size: typeof fileRecord.file_size === 'number' ? fileRecord.file_size : undefined,
  }
}

function newMessageBlockTypes(messages: unknown): string[] {
  if (!Array.isArray(messages)) {
    return []
  }
  const types: string[] = []
  for (const message of messages) {
    const content = (message as { message?: { content?: unknown }; content?: unknown })?.message?.content ??
      (message as { content?: unknown })?.content
    collectContentBlockTypes(content, types)
  }
  return types
}

function summarizeApiMessages(messages: unknown[]): ApiMediaSummary {
  const summary: ApiMediaSummary = {
    text_blocks: 0,
    image_blocks: 0,
    document_blocks: 0,
    pdf_document_blocks: 0,
    tool_use_blocks: 0,
    tool_result_blocks: 0,
    tool_use_names: [],
    tool_result_names: [],
    image_media_types: [] as string[],
    document_media_types: [] as string[],
  }
  for (const message of messages) {
    collectApiContentSummary((message as { content?: unknown })?.content, summary)
  }
  summary.tool_use_names = [...new Set(summary.tool_use_names)]
  summary.tool_result_names = [...new Set(summary.tool_result_names)]
  summary.image_media_types = [...new Set(summary.image_media_types)]
  summary.document_media_types = [...new Set(summary.document_media_types)]
  return summary
}

function collectApiContentSummary(content: unknown, summary: ApiMediaSummary): void {
  if (typeof content === 'string') {
    summary.text_blocks += 1
    return
  }
  if (!Array.isArray(content)) {
    return
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue
    }
    const record = block as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : ''
    if (type === 'text') {
      summary.text_blocks += 1
    } else if (type === 'image') {
      summary.image_blocks += 1
      const mediaType = nestedMediaType(record.source)
      if (mediaType) summary.image_media_types.push(mediaType)
    } else if (type === 'document') {
      summary.document_blocks += 1
      const mediaType = nestedMediaType(record.source)
      if (mediaType) {
        summary.document_media_types.push(mediaType)
        if (mediaType === 'application/pdf') summary.pdf_document_blocks += 1
      }
    } else if (type === 'tool_use') {
      summary.tool_use_blocks += 1
      if (typeof record.name === 'string') summary.tool_use_names.push(record.name)
    } else if (type === 'tool_result') {
      summary.tool_result_blocks += 1
      if (typeof record.name === 'string') summary.tool_result_names.push(record.name)
      collectApiContentSummary(record.content, summary)
    }
  }
}

function collectContentBlockTypes(content: unknown, types: string[]): void {
  if (typeof content === 'string') {
    types.push('string')
    return
  }
  if (!Array.isArray(content)) {
    return
  }
  for (const block of content) {
    if (block && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string') {
      types.push((block as { type: string }).type)
    }
  }
}

function nestedMediaType(value: unknown): string {
  return value && typeof value === 'object' && typeof (value as { media_type?: unknown }).media_type === 'string'
    ? (value as { media_type: string }).media_type
    : ''
}

function requestURL(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.href
  }
  return typeof (input as { url?: unknown })?.url === 'string' ? (input as { url: string }).url : ''
}

async function requestBodyText(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<string> {
  if (typeof init?.body === 'string') {
    return init.body
  }
  if (init?.body instanceof Uint8Array) {
    return Buffer.from(init.body).toString('utf8')
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.clone().text()
  }
  return ''
}

function apiURLKind(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url.includes('/messages') ? '/messages' : ''
  }
}

function errorSummary(error: unknown): Record<string, unknown> {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  }
}

function configureSessionEventStore(options: SDKSessionOptions): void {
  if (options.sessionEventWriter) {
    setInternalEventWriter(options.sessionEventWriter)
  }
  if (options.sessionEventReader) {
    setInternalEventReader(
      options.sessionEventReader,
      options.sessionSubagentEventReader ?? (async () => []),
    )
  }
}

// @[MODEL LAUNCH]: Update the example model ID in this docstring.
/**
 * V2 API - UNSTABLE
 * One-shot convenience: creates a session, sends a single prompt, collects
 * the SDKResultMessage, and returns it.
 *
 * @alpha
 *
 * @example
 * ```typescript
 * const result = await unstable_v2_prompt("What files are here?", {
 *   cwd: '/my/project',
 *   model: 'claude-sonnet-4-6',
 * })
 * console.log(result.result) // text output
 * ```
 */
export async function unstable_v2_prompt(
  message: string,
  options: SDKSessionOptions,
): Promise<SDKResultMessage> {
  const session = unstable_v2_createSession(options)
  try {
    let resultMessage: SDKResultMessage | undefined

    for await (const msg of session.sendMessage(message)) {
      if (msg.type === 'result') {
        resultMessage = msg as SDKResultMessage
      }
    }

    if (!resultMessage) {
      throw new Error('unstable_v2_prompt: query completed without a result message')
    }

    return resultMessage
  } finally {
    session.close()
  }
}

export async function unstable_v2_generateSessionTitle(
  description: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // The title primitive is a valid standalone SDK entrypoint. Unlike
  // SDKSession.sendMessage(), it has no session lifecycle that would otherwise
  // initialize config/provider state before queryHaiku reads it.
  await init()
  const titleSignal = signal ?? createAbortController().signal
  return titleOrNullForPromptFallback(
    await generateSourceSessionTitle(description, titleSignal),
  )
}

/**
 * Initialize the SDK runtime without creating a session or sending a message.
 *
 * Remote hosts use this after installing the turn-scoped environment so the
 * native SDK initialization can overlap independent snapshot hydration. The
 * same memoized initializer is still awaited by sendMessage(), so this changes
 * only when initialization runs, not which initialization path owns it.
 */
export async function unstable_v2_initializeRuntime(): Promise<void> {
  await init()
}
