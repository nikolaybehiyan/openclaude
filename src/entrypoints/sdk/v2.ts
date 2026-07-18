/**
 * V2 API for the SDK — persistent sessions and one-shot prompt.
 *
 * Provides SDKSession, SDKSessionImpl, createEngineFromOptions,
 * and the unstable_v2_* functions.
 */

import { randomUUID } from 'crypto'
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
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js'
import type {
  HookEvent,
  SDKResultMessage as GeneratedSDKResultMessage,
} from './coreTypes.generated.js'
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
import { generateSessionTitle as generateSourceSessionTitle } from '../../utils/sessionTitle.js'
import { truncateToWidth } from '../../utils/format.js'
import { getLastCacheSafeParams } from '../../utils/forkedAgent.js'
import { runSideQuestion as runSourceSideQuestion } from '../../utils/sideQuestion.js'
import { createAbortController } from '../../utils/abortController.js'
import { addFunctionHook } from '../../utils/hooks/sessionHooks.js'
import { clearCommandsCache, getCommands } from '../../commands.js'
import { resetSentSkillNames } from '../../utils/attachments.js'
import type { Tool, ToolPermissionContext } from '../../Tool.js'
import type { Command } from '../../types/command.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
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
  private commands: Command[] = []
  private skillsLoaded = false
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

    this.options = nextOptions
    if (permissionContextChanged || mcpServersChanged) {
      this.applyPermissionContextFromOptions()
    }
  }

  reloadSkills(): void {
    clearCommandsCache()
    resetSentSkillNames()
    this.skillsLoaded = false
  }

  private async ensureSkillsLoaded(): Promise<void> {
    if (this.skillsLoaded) {
      return
    }
    const commands = await getCommands(this.options.cwd)
    this.commands.splice(0, this.commands.length, ...commands)
    this.skillsLoaded = true
  }

  async *sendMessage(content: string | ContentBlockParam[], options?: { uuid?: string }): AsyncIterable<SDKMessage> {
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
        await self.ensureSkillsLoaded()
        if (self.options.settings?.sandbox) {
          const unavailable = SandboxManager.getSandboxUnavailableReason()
          if (unavailable) {
            throw new Error(`Sandbox runtime is required but unavailable: ${unavailable}`)
          }
        }
        await SandboxManager.initialize(async () => false)
        if (
          self.options.settings?.sandbox &&
          !SandboxManager.isSandboxingEnabled()
        ) {
          throw new Error('Sandbox runtime is required but did not initialize')
        }

        // Load agent definitions once (not on every sendMessage call)
        if (!self.agentsLoaded) {
          try {
            const agentDefs = await getAgentDefinitionsWithOverrides(self.options.cwd)
            self.appStateStore.setState(prev => ({
              ...prev,
              agentDefinitions: agentDefs,
            }))
            if (agentDefs.activeAgents.length > 0) {
              self.engine.injectAgents(agentDefs.activeAgents)
            }
          } catch (err) {
            // Agent loading failed — continue without agents but emit failure event
            const errorMessage = err instanceof Error ? err.message : String(err)
            console.warn('SDK: agent loading failed:', errorMessage)
            self.pushAgentFailure({
              type: 'agent_load_failure',
              stage: 'definitions',
              error_message: errorMessage,
            })
          }
          self.agentsLoaded = true
        }

        await self.ensureMcpServersConnected()

        // Switch session for transcript writes using session's own resolved dir
        switchSession(self._sessionId as SessionId, self._sessionProjectDir)

        try {
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
        await self.ensureSkillsLoaded()
        if (self.options.settings?.sandbox) {
          const unavailable = SandboxManager.getSandboxUnavailableReason()
          if (unavailable) {
            throw new Error(`Sandbox runtime is required but unavailable: ${unavailable}`)
          }
        }
        await SandboxManager.initialize(async () => false)
        if (
          self.options.settings?.sandbox &&
          !SandboxManager.isSandboxingEnabled()
        ) {
          throw new Error('Sandbox runtime is required but did not initialize')
        }
        const retryPrompt = self.recreateEngineAtUserMessage(parentUserMessageUuid)
        if (!self.agentsLoaded) {
          try {
            const agentDefs = await getAgentDefinitionsWithOverrides(self.options.cwd)
            self.appStateStore.setState(prev => ({
              ...prev,
              agentDefinitions: agentDefs,
            }))
            if (agentDefs.activeAgents.length > 0) {
              self.engine.injectAgents(agentDefs.activeAgents)
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err)
            console.warn('SDK: agent loading failed:', errorMessage)
            self.pushAgentFailure({
              type: 'agent_load_failure',
              stage: 'definitions',
              error_message: errorMessage,
            })
          }
          self.agentsLoaded = true
        }
        await self.ensureMcpServersConnected()
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
    const oldMcpClients = this._engine?.getMcpClients?.() ?? []
    for (const client of oldMcpClients) {
      if (client.type === 'connected' && client.cleanup) {
        void client.cleanup().catch(err => {
          console.warn('SDK: MCP client cleanup error before session history replacement:', err instanceof Error ? err.message : String(err))
        })
      }
    }
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
    this.agentsLoaded = false
    this.mcpConnected = false
    this.mcpTools = []
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
    const title = await generateSourceSessionTitle(description, controller.signal)
    return title ?? truncateToWidth(description, 75)
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
    if (!this.mcpServers || Object.keys(this.mcpServers).length === 0) {
      this.mcpConnected = true
      return
    }
    try {
      const { clients: mcpClients, tools: mcpTools } = await connectSdkMcpServers(this.mcpServers)
      this.engine.setMcpClients(mcpClients)
      this.mcpTools = mcpTools
      this.applyPermissionContextFromOptions()
    } catch (err) {
      // MCP connection failed — continue without MCP tools
      console.warn('SDK: MCP server connection failed:', err instanceof Error ? err.message : String(err))
    }
    this.mcpConnected = true
  }

  private disconnectMcpClients(reason: string): void {
    const mcpClients = this._engine?.getMcpClients?.() ?? []
    for (const client of mcpClients) {
      if (client.type === 'connected' && client.cleanup) {
        void client.cleanup().catch(err => {
          console.warn(`SDK: MCP client cleanup error during ${reason}:`, err instanceof Error ? err.message : String(err))
        })
      }
    }
    this._engine?.setMcpClients?.([])
  }

  close(): void {
    this.interrupt()
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

function mergeRuntimeTools(builtinTools: Tool[], mcpTools: Tool[]): Tool[] {
  const merged = [...builtinTools]
  for (const tool of mcpTools) {
    if (!merged.some(existing => existing.name === tool.name)) {
      merged.push(tool)
    }
  }
  return merged
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
  emitBridgeDiagnostic('api_request_media', {
    url_kind: apiURLKind(url),
    model: typeof body.model === 'string' ? body.model : '',
    message_count: messages.length,
    media: summarizeApiMessages(messages),
  })
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
  const title = await generateSourceSessionTitle(description, titleSignal)
  return title ?? truncateToWidth(description, 75)
}
