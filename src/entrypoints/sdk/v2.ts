/**
 * V2 API for the SDK — persistent sessions and one-shot prompt.
 *
 * Provides SDKSession, SDKSessionImpl, createEngineFromOptions,
 * and the unstable_v2_* functions.
 */

import { randomUUID } from 'crypto'
import { dirname } from 'path'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { QueryEngine } from '../../QueryEngine.js'
import {
  getDefaultAppState,
  type AppState,
} from '../../state/AppStateStore.js'
import { createStore, type Store } from '../../state/store.js'
import {
  type ToolPermissionContext,
} from '../../Tool.js'
import { getTools } from '../../tools.js'
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
  setFlagSettingsInline,
} from '../../bootstrap/state.js'
import {
  hydrateFromCCRv2InternalEvents,
  setInternalEventReader,
  setInternalEventWriter,
} from '../../utils/sessionStorage.js'
import type { SessionId } from '../../types/ids.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import type {
  PermissionResult,
  SDKResultMessage as GeneratedSDKResultMessage,
} from './coreTypes.generated.js'
import type {
  SDKMessage,
  SDKAgentLoadFailureMessage,
  JsonlEntry,
  QueryPermissionMode,
  CanUseToolCallback,
  SDKPermissionRequestMessage,
} from './shared.js'
import {
  assertValidSessionId,
  mapMessageToSDK,
} from './shared.js'
import {
  buildPermissionContext,
  createExternalCanUseTool,
  connectSdkMcpServers,
  createDefaultCanUseTool,
  createOnceOnlyResolve,
  type PermissionResolveDecision,
  type PermissionTarget,
} from './permissions.js'
import {
  parseJsonlEntries,
  findLastCompactBoundary,
  applyPreservedSegmentRelinks,
  buildConversationChain as buildChain,
  stripExtraFields as stripChainFields,
} from './transcript.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { getRunningTasks } from '../../utils/task/framework.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { stopTask } from '../../tasks/stopTask.js'
import { sleep } from '../../utils/sleep.js'
import { generateSessionTitle as generateSourceSessionTitle } from '../../utils/sessionTitle.js'
import { truncateToWidth } from '../../utils/format.js'
import { getLastCacheSafeParams } from '../../utils/forkedAgent.js'
import { runSideQuestion as runSourceSideQuestion } from '../../utils/sideQuestion.js'
import { createAbortController } from '../../utils/abortController.js'

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
   * **Secure-by-default**: If neither `canUseTool` nor `onPermissionRequest`
   * is provided, ALL tool uses are denied. You MUST provide at least one of
   * these callbacks to allow tool execution.
   */
  canUseTool?: CanUseToolCallback
  /** MCP server configurations for this session. */
  mcpServers?: Record<string, unknown>
  /**
   * Callback invoked when a tool needs permission approval. The host receives
   * the request immediately and can resolve it via respondToPermission().
   */
  onPermissionRequest?: (message: SDKPermissionRequestMessage) => void
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
  /** In-memory flag settings for this session. Used by managed/headless hosts. */
  settings?: Record<string, unknown>
  /** When true, yields stream_event messages for token-by-token streaming. */
  includePartialMessages?: boolean
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
}

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
  sendMessage(content: string, options?: { uuid?: string }): AsyncIterable<SDKMessage>
  /** Regenerate an assistant response from an existing user message UUID. */
  retryMessage(parentUserMessageUuid: string): AsyncIterable<SDKMessage>
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
  /**
   * Respond to a pending permission prompt asynchronously.
   * Use this when no canUseTool callback was provided — the SDK emits a
   * permission-request message and the host resolves it via this method.
   */
  respondToPermission(toolUseId: string, decision: PermissionResult): void
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
  private pendingPermissionPrompts = new Map<string, {
    resolve: (decision: PermissionResolveDecision) => void
  }>()
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

  /** Set the resolved transcript directory (called by resumeSession after resolving the JSONL path). */
  setSessionProjectDir(dir: string): void {
    this._sessionProjectDir = dir
  }

  get sessionId(): string {
    return this._sessionId
  }

  async *sendMessage(content: string, options?: { uuid?: string }): AsyncIterable<SDKMessage> {
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

        // Connect MCP servers once (lazy, on first message)
        if (!self.mcpConnected && self.mcpServers && Object.keys(self.mcpServers).length > 0) {
          try {
            const { clients: mcpClients, tools: mcpTools } = await connectSdkMcpServers(self.mcpServers)
            if (mcpClients.length > 0) {
              self.engine.setMcpClients(mcpClients)
            }
            if (mcpTools.length > 0) {
              const permissionContext = self.appStateStore.getState().toolPermissionContext
              const allTools = [...getTools(permissionContext)]  // Mutable copy
              for (const mcpTool of mcpTools) {
                if (!allTools.some(t => t.name === mcpTool.name)) {
                  allTools.push(mcpTool)
                }
              }
              self.engine.updateTools(allTools)
            }
          } catch (err) {
            // MCP connection failed — continue without MCP tools
            console.warn('SDK: MCP server connection failed:', err instanceof Error ? err.message : String(err))
          }
          self.mcpConnected = true
        }

        // Switch session for transcript writes using session's own resolved dir
        switchSession(self._sessionId as SessionId, self._sessionProjectDir)

        try {
          let heldBackResult: SDKMessage | null = null
          for await (const engineMsg of self.engine.submitMessage(content, options)) {
            if (engineMsg.type === 'result' && self.shouldHoldResultForBackgroundTasks()) {
              heldBackResult = engineMsg
            } else {
              yield engineMsg
            }
            yield* drainSdkEvents()
            yield* self.drainAgentFailureQueue()
          }
          while (self.hasRunningBackgroundTasks() && !self._abortController?.signal.aborted) {
            yield* drainSdkEvents()
            yield* self.drainAgentFailureQueue()
            await sleep(100, self._abortController?.signal, { unref: true })
          }
          // Final drain for task/progress/failure messages that fired on the last engine yield.
          yield* drainSdkEvents()
          yield* self.drainAgentFailureQueue()
          if (heldBackResult) {
            yield heldBackResult
          }
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
        if (!self.mcpConnected && self.mcpServers && Object.keys(self.mcpServers).length > 0) {
          try {
            const { clients: mcpClients, tools: mcpTools } = await connectSdkMcpServers(self.mcpServers)
            if (mcpClients.length > 0) {
              self.engine.setMcpClients(mcpClients)
            }
            if (mcpTools.length > 0) {
              const permissionContext = self.appStateStore.getState().toolPermissionContext
              const allTools = [...getTools(permissionContext)]
              for (const mcpTool of mcpTools) {
                if (!allTools.some(t => t.name === mcpTool.name)) {
                  allTools.push(mcpTool)
                }
              }
              self.engine.updateTools(allTools)
            }
          } catch (err) {
            console.warn('SDK: MCP server connection failed:', err instanceof Error ? err.message : String(err))
          }
          self.mcpConnected = true
        }
        switchSession(self._sessionId as SessionId, self._sessionProjectDir)
        let heldBackResult: SDKMessage | null = null
        try {
          for await (const engineMsg of self.engine.submitMessage(retryPrompt, { uuid: parentUserMessageUuid })) {
            if (engineMsg.type === 'result' && self.shouldHoldResultForBackgroundTasks()) {
              heldBackResult = engineMsg
            } else {
              yield engineMsg
            }
            yield* drainSdkEvents()
            yield* self.drainAgentFailureQueue()
          }
          while (self.hasRunningBackgroundTasks() && !self._abortController?.signal.aborted) {
            yield* drainSdkEvents()
            yield* self.drainAgentFailureQueue()
            await sleep(100, self._abortController?.signal, { unref: true })
          }
          yield* drainSdkEvents()
          yield* self.drainAgentFailureQueue()
          if (heldBackResult) {
            yield heldBackResult
          }
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
    const oldMcpClients = this._engine?.getMcpClients?.() ?? []
    for (const client of oldMcpClients) {
      if (client.type === 'connected' && client.cleanup) {
        void client.cleanup().catch(err => {
          console.warn('SDK: MCP client cleanup error before session history replacement:', err instanceof Error ? err.message : String(err))
        })
      }
    }
    const { engine, appStateStore, abortController } = createEngineFromOptions(
      this.options,
      this,
      messages,
      this._sessionId,
    )
    this._engine = engine
    this._appStateStore = appStateStore
    this._abortController = abortController
    this.agentsLoaded = false
    this.mcpConnected = false
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

  interrupt(): void {
    if (this._engine) {
      this._engine.interrupt()
    }
    // Deny all pending permission prompts before clearing
    for (const [toolUseId, pending] of this.pendingPermissionPrompts) {
      pending.resolve({
        behavior: 'deny',
        message: 'Session interrupted',
        decisionReason: { type: 'mode', mode: 'default' },
      })
    }
    this.pendingPermissionPrompts.clear()
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
  }

  /**
   * Register a pending permission prompt for external resolution.
   * Returns a Promise that resolves when respondToPermission() is called
   * with the matching toolUseId.
   */
  registerPendingPermission(toolUseId: string): Promise<PermissionResolveDecision> {
    return new Promise(resolve => {
      const wrappedResolve = createOnceOnlyResolve(resolve)
      this.pendingPermissionPrompts.set(toolUseId, { resolve: wrappedResolve })
    })
  }

  /** Delete a pending permission prompt without resolving it. */
  deletePendingPermission(toolUseId: string): void {
    this.pendingPermissionPrompts.delete(toolUseId)
  }

  /** Deny a pending permission prompt with a message and clean up. */
  denyPendingPermission(toolUseId: string, message: string): void {
    const pending = this.pendingPermissionPrompts.get(toolUseId)
    if (pending) {
      pending.resolve({
        behavior: 'deny',
        message,
        decisionReason: { type: 'mode', mode: 'default' },
      })
      this.pendingPermissionPrompts.delete(toolUseId)
    }
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

  respondToPermission(toolUseId: string, decision: PermissionResult): void {
    const pending = this.pendingPermissionPrompts.get(toolUseId)
    if (!pending) return

    if (decision.behavior === 'allow') {
      pending.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput,
      })
    } else {
      pending.resolve({
        behavior: 'deny',
        message: decision.message ?? 'Permission denied',
        decisionReason: { type: 'mode', mode: 'default' },
      })
    }
    this.pendingPermissionPrompts.delete(toolUseId)
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
  permissionTarget: PermissionTarget,
  initialMessages?: any[],
  sessionId?: string,
): { engine: QueryEngine; appStateStore: Store<AppState>; abortController: AbortController } {
  const { cwd, model, abortController, permissionMode } = options

  if (!cwd) {
    throw new Error('SDKSessionOptions requires cwd')
  }
  configureSessionEventStore(options)
  applySessionFlagSettings(options.settings)

  // NOTE: cwd is NOT set on global state here. SDKSessionImpl.sendMessage()
  // sets/restores it per-message via the cwd mutex to prevent concurrent
  // sessions from overwriting each other's working directory.

  // Build permission context
  const permissionContext = buildPermissionContext({
    cwd,
    permissionMode,
    disallowedTools: options.disallowedTools,
  })

  // Create AppState store (minimal, headless)
  const initialAppState = getDefaultAppState()
  const stateWithPermissions = {
    ...initialAppState,
    toolPermissionContext: permissionContext,
  }
  if (model) {
    stateWithPermissions.mainLoopModel = model
    stateWithPermissions.mainLoopModelForSession = model
  }
  const appStateStore = createStore<AppState>(stateWithPermissions)

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

  // Build the canUseTool callback with external permission resolution support.
  // When no user canUseTool callback is provided, this creates a pending
  // prompt entry that respondToPermission() can resolve asynchronously.
  const defaultCanUseTool = createDefaultCanUseTool(permissionContext)
  const canUseTool = createExternalCanUseTool(
    options.canUseTool ?? undefined,
    defaultCanUseTool,
    permissionTarget,
    options.onPermissionRequest,
    sessionId,
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
  const engineConfig = {
    cwd,
    tools,
    commands: [] as Array<never>,
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
    includePartialMessages: options.includePartialMessages ?? false,
    ...(initialMessages ? { initialMessages } : {}),
  }

  const engine = new QueryEngine(engineConfig)

  return { engine, appStateStore, abortController: ac }
}

function applySessionFlagSettings(settings?: Record<string, unknown>): void {
  if (!settings || Object.keys(settings).length === 0) {
    return
  }
  setFlagSettingsInline(settings)
  settingsChangeDetector.notifyChange('flagSettings')
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
  // Create SDKSessionImpl first (without engine) so we can pass its
  // pendingPermissionPrompts map to createEngineFromOptions for
  // external permission resolution support.
  const session = new SDKSessionImpl(null, sessionId, options, null)
  const { engine, appStateStore, abortController } = createEngineFromOptions(options, session, undefined, sessionId)
  // Wire the engine, store, and abort controller into the session
  session.setEngine(engine)
  session.setAppStateStore(appStateStore)
  session.setAbortController(abortController)
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
  const { engine, appStateStore, abortController } = createEngineFromOptions(
    sessionOptions,
    session,
    initialMessages as any[],
    sessionId,
  )
  session.setEngine(engine)
  session.setAppStateStore(appStateStore)
  session.setAbortController(abortController)

  // Store the resolved transcript directory for correct routing in sendMessage()
  // and set global state so tests and legacy code can verify the routing.
  if (resolved) {
    const transcriptDir = dirname(resolved.filePath)
    session.setSessionProjectDir(transcriptDir)
    switchSession(sessionId as SessionId, transcriptDir)
  }

  return session
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
  const titleSignal = signal ?? createAbortController().signal
  const title = await generateSourceSessionTitle(description, titleSignal)
  return title ?? truncateToWidth(description, 75)
}
