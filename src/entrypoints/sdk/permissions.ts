/**
 * Permission handling for the SDK.
 *
 * Provides canUseTool wrappers, permission context building,
 * MCP server connection, and default permission-denying logic.
 *
 * @internal — these utilities are not part of the public SDK API.
 */

import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../../types/permissions.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
  type Tool,
} from '../../Tool.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { MCPTool } from '../../tools/MCPTool/MCPTool.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { connectToServer, fetchToolsForClient } from '../../services/mcp/client.js'
import type {
  QueryPermissionMode,
  CanUseToolCallback,
} from './shared.js'

type SdkMcpToolOutput = string | Array<{ type: string; text?: string }>

// ============================================================================
// Logger interface for SDK surface
// ============================================================================

/**
 * Logger interface for SDK permission system.
 * Hosts can inject a custom logger to control warning output.
 * Defaults to console.warn if no logger is provided.
 */
export interface SDKLogger {
  warn(message: string): void
}

/** Default console-based logger used when no custom logger is provided. */
const defaultLogger: SDKLogger = {
  warn: (message: string) => console.warn(message),
}

// ============================================================================
// buildPermissionContext
// ============================================================================

export interface PermissionContextOptions {
  cwd: string
  permissionMode?: QueryPermissionMode
  additionalDirectories?: string[]
  allowDangerouslySkipPermissions?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
}

export function buildPermissionContext(options: PermissionContextOptions): ToolPermissionContext {
  const base: ToolPermissionContext = getEmptyToolPermissionContext()
  const mode = options.permissionMode ?? 'default'

  // Map SDK permission mode to internal PermissionMode
  let internalMode: string = 'default'
  switch (mode) {
    case 'plan':
      internalMode = 'plan'
      break
    case 'auto-accept': // Alias for acceptEdits
    case 'acceptEdits':
      internalMode = 'acceptEdits'
      break
    case 'bypass-permissions':
    case 'bypassPermissions':
      internalMode = 'bypassPermissions'
      break
    case 'auto':
      internalMode = 'auto'
      break
    case 'dontAsk':
      internalMode = 'dontAsk'
      break
    default:
      internalMode = 'default'
  }

  // Wire additionalDirectories into the permission context
  if (options.additionalDirectories && options.additionalDirectories.length > 0) {
    const dirsMap = base.additionalWorkingDirectories as Map<string, unknown>
    for (const dir of options.additionalDirectories) {
      dirsMap.set(dir, true)
    }
  }

  return {
    ...base,
    mode: internalMode as ToolPermissionContext['mode'],
    isBypassPermissionsModeAvailable:
      mode === 'bypass-permissions' || mode === 'bypassPermissions' || options.allowDangerouslySkipPermissions === true,
    alwaysAllowRules: {
      ...base.alwaysAllowRules,
      cliArg: options.allowedTools ?? [],
    },
    alwaysDenyRules: {
      ...base.alwaysDenyRules,
      cliArg: options.disallowedTools ?? [],
    },
  }
}

export function applyBuiltinToolsFilter(
  permissionContext: ToolPermissionContext,
  tools: string[] | undefined,
  defaultBuiltins: readonly string[],
): ToolPermissionContext {
  if (!Array.isArray(tools)) {
    return permissionContext
  }
  const selected = new Set(
    tools
      .map(tool => tool.trim())
      .filter(Boolean),
  )
  if (selected.has('default')) {
    return permissionContext
  }
  const unavailableBuiltins = defaultBuiltins.filter(
    tool => !selected.has(tool),
  )
  if (unavailableBuiltins.length === 0) {
    return permissionContext
  }
  return {
    ...permissionContext,
    alwaysDenyRules: {
      ...permissionContext.alwaysDenyRules,
      cliArg: [
        ...(permissionContext.alwaysDenyRules.cliArg ?? []),
        ...unavailableBuiltins,
      ],
    },
  }
}

// ============================================================================
// createExternalCanUseTool
// ============================================================================

/**
 * Creates a canUseTool function for SDK hosts.
 *
 * OpenClaude's permission engine always runs first. If it returns allow or
 * deny, the SDK preserves that decision. If it returns ask, the SDK delegates
 * to the host-provided canUseTool callback. Without that callback the request
 * is denied by default.
 *
 * The flow:
 * 1. QueryEngine calls canUseTool(tool, input, ..., toolUseID, forceDecision)
 * 2. If forceDecision is set, honor it immediately
 * 3. Run the source permission fallback
 * 4. If the fallback asks, delegate to user canUseTool or deny
 */
export function createExternalCanUseTool(
  userFn: CanUseToolCallback | undefined,
  fallback: CanUseToolFn,
  logger?: SDKLogger,
): CanUseToolFn {
  const log = logger ?? defaultLogger
  return async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision): Promise<PermissionDecision> => {
    // Cast input to ensure type compatibility with PermissionDecision
    const typedInput = input as Record<string, unknown>
    const baseDecision = forceDecision ?? await fallback(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
    )
    if (baseDecision.behavior === 'allow' || baseDecision.behavior === 'deny') {
      return baseDecision
    }

    // The OpenClaude permission engine decides whether a tool requires user
    // approval. A host callback only resolves that source `ask` decision; it
    // must not replace the built-in safety/rule checks.
    if (userFn) {
      try {
        const result = await userFn(tool.name, typedInput, { toolUseID })
        if (result.behavior === 'allow') {
          return { behavior: 'allow' as const, updatedInput: (result.updatedInput as Record<string, unknown> | undefined) ?? typedInput }
        }
        return {
          behavior: 'deny' as const,
          message: result.message ?? `Tool ${tool.name} denied by canUseTool callback`,
          decisionReason: { type: 'mode' as const, mode: 'default' },
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown callback error'
        return {
          behavior: 'deny' as const,
          message: `Tool ${tool.name} denied (callback error: ${errorMessage})`,
          decisionReason: { type: 'mode' as const, mode: 'default' },
        }
      }
    }

    if (!warnedDefaultPermissions) {
      warnedDefaultPermissions = true
      log.warn(
        `[SDK] Tool "${tool.name}" requires permission but no external permission handler is available. ` +
        'Denying by default. Provide canUseTool in SDK options.',
      )
    }
    return {
      behavior: 'deny',
      message: `SDK: Tool "${tool.name}" denied — permission was required but no external handler was available.`,
      decisionReason: { type: 'mode', mode: 'default' },
    }
  }
}

// ============================================================================
// MCP server connection for SDK
// ============================================================================

/**
 * Connects to MCP servers from SDK options.
 * Takes the mcpServers config and connects to each server,
 * returning connected clients and their tools.
 *
 * @param mcpServers - MCP server configurations from SDK options
 * @returns Connected clients and their tools
 */
export async function connectSdkMcpServers(
  mcpServers: Record<string, unknown> | undefined,
): Promise<{ clients: MCPServerConnection[]; tools: Tool[] }> {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return { clients: [], tools: [] }
  }

  const clients: MCPServerConnection[] = []
  const tools: Tool[] = []

  // Connect to each server in parallel
  const results = await Promise.allSettled(
    Object.entries(mcpServers).map(async ([name, config]) => {
      // Validate config is a non-null object before spreading (arrays are objects but invalid for config)
      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return {
          client: {
            type: 'failed' as const,
            name,
            config: { scope: 'session' } as unknown as ScopedMcpServerConfig,
            error: `Invalid MCP server config for '${name}': expected object, got ${config === null ? 'null' : Array.isArray(config) ? 'array' : typeof config}`,
          },
          tools: [],
        }
      }

      const sdkConfig = config as Record<string, unknown>
      const toolAllowlist = sdkMcpToolAllowlist(sdkConfig.toolAllowlist)

      // Convert SDK config to internal format with session scope. SDK-only
      // projection fields must not leak into the transport configuration.
      // Note: 'session' is SDK-specific, not part of internal ConfigScope
      const {
        toolAllowlist: _toolAllowlist,
        persistedTools: _persistedTools,
        ...transportConfig
      } = sdkConfig
      const scopedConfig = {
        ...transportConfig,
        scope: 'session',
      } as const

      // SDK-type MCP servers (type: 'sdk') carry in-process tool definitions
      // created via the tool() helper. Convert SdkMcpToolDefinition to Tool
      // using the MCPTool pattern (spread MCPTool base + override fields).
      if ((config as Record<string, unknown>).type === 'sdk') {
        type SdkToolDef = {
          name: string
          description?: string
          inputSchema?: Record<string, unknown>
          handler?: (args: unknown, extra: unknown) => Promise<{
            content: unknown
            isError?: boolean
            _meta?: Record<string, unknown>
            structuredContent?: Record<string, unknown>
          }>
          annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
          permissionBehavior?: 'allow' | 'ask' | 'deny'
          searchHint?: string
          alwaysLoad?: boolean
          maxResultSizeChars?: number
          deferInputValidationToHandler?: boolean
          _meta?: Record<string, unknown>
          mcpInfo?: { serverName: string; toolName: string }
        }
        const sdkConfig = config as { type: 'sdk'; name: string; tools?: SdkToolDef[] }
        const sdkToolDefs = sdkConfig.tools ?? []
        const convertedTools: Tool[] = sdkToolDefs.map(toolDef => ({
          ...MCPTool,
          name: toolDef.name,
          isMcp: true,
          ...(toolDef.mcpInfo ? { mcpInfo: toolDef.mcpInfo } : {}),
          searchHint: toolDef.searchHint,
          alwaysLoad: toolDef.alwaysLoad,
          maxResultSizeChars: sdkMcpToolMaxResultSizeChars(toolDef.maxResultSizeChars),
          ...(toolDef._meta ? { _meta: toolDef._meta } : {}),
          async description() {
            return toolDef.description ?? ''
          },
          async prompt() {
            return toolDef.description ?? ''
          },
          inputJSONSchema: toolDef.inputSchema as Tool['inputJSONSchema'],
          isConcurrencySafe() {
            return toolDef.annotations?.readOnlyHint ?? false
          },
          isReadOnly() {
            return toolDef.annotations?.readOnlyHint ?? false
          },
          isDestructive() {
            return toolDef.annotations?.destructiveHint ?? false
          },
          isOpenWorld() {
            return toolDef.annotations?.openWorldHint ?? false
          },
          async validateInput(input, context) {
            if (toolDef.deferInputValidationToHandler === true) {
              return { result: true as const }
            }
            return MCPTool.validateInput?.call(this, input, context) ?? { result: true as const }
          },
          async checkPermissions(input, context) {
            switch (toolDef.permissionBehavior) {
              case 'allow':
                return { behavior: 'allow' as const }
              case 'deny':
                return {
                  behavior: 'deny' as const,
                  message: `Permission to use ${toolDef.name} has been denied.`,
                  decisionReason: { type: 'mode' as const, mode: 'default' },
                }
              case 'ask':
                return {
                  behavior: 'ask' as const,
                  message: `OpenClaude needs your permission to use ${toolDef.name}`,
                }
              default:
                return MCPTool.checkPermissions(input, context)
            }
          },
          async call(args: Record<string, unknown>, context, _canUseTool, parentMessage, onProgress) {
            if (!toolDef.handler) {
              return { data: `SDK tool ${toolDef.name} has no handler` }
            }
            const result = await toolDef.handler(args, { context, parentMessage, onProgress })
            if (result.isError === true) {
              throw new Error(sdkMcpToolErrorText(result.content))
            }
            const mcpMeta =
              result && typeof result === 'object'
                ? {
                    ...('_meta' in result && result._meta
                      ? { _meta: result._meta as Record<string, unknown> }
                      : {}),
                    ...('structuredContent' in result && result.structuredContent
                      ? { structuredContent: result.structuredContent as Record<string, unknown> }
                      : {}),
                  }
                : {}
            return {
              data: result.content as SdkMcpToolOutput,
              ...(Object.keys(mcpMeta).length > 0 ? { mcpMeta } : {}),
            }
          },
        }))
        return {
          client: null as unknown as MCPServerConnection,
          tools: convertedTools,
        }
      }

      try {
        // Connect to the server
        // Note: SDK 'session' scope is not part of internal ConfigScope,
        // but connectToServer accepts any object with scope field
        const client = await connectToServer(name, scopedConfig as unknown as ScopedMcpServerConfig, {
          totalServers: Object.keys(mcpServers).length,
          stdioCount: 0,
          sseCount: 0,
          httpCount: 0,
          sseIdeCount: 0,
          wsIdeCount: 0,
        })

        // connectToServer represents transport failures as a failed client
        // instead of rejecting. Surface the reason in SDK mode as well; the
        // incremental session startup intentionally does not await remote MCP
        // transports, so without this diagnostic a failed server otherwise
        // looks indistinguishable from a connected server with zero tools.
        if (client.type === 'failed') {
          console.warn(`SDK: MCP server ${name} failed: ${client.error}`)
        }

        // If connected, fetch tools
        if (client.type === 'connected') {
          const serverTools = await fetchToolsForClient(client)
          return { client, tools: filterSdkMcpToolsByAllowlist(serverTools, toolAllowlist) }
        }

        // Return failed/pending client with no tools
        return { client, tools: [] }
      } catch (error) {
        // Connection failed, return failed client with error message
        const errorMessage = error instanceof Error
          ? error.message
          : 'Unknown error'
        return {
          client: {
            type: 'failed' as const,
            name,
            config: scopedConfig,
            error: errorMessage,
          },
          tools: [],
        }
      }
    }),
  )

  // Process results — skip SDK-type entries (returned as null client)
  for (const result of results) {
    if (result.status === 'fulfilled') {
      // SDK-type servers return null client — only push real clients
      if (result.value.client != null) {
        // Cast needed: failed client from invalid config has session-scoped config
        clients.push(result.value.client as MCPServerConnection)
      }
      tools.push(...result.value.tools)
    }
  }

  return { clients, tools }
}

function sdkMcpToolAllowlist(value: unknown): Set<string> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error('SDK MCP toolAllowlist must be an array of non-empty strings')
  }
  const names = value.map(item => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error('SDK MCP toolAllowlist must contain only non-empty strings')
    }
    return item.trim()
  })
  return new Set(names)
}

export function filterSdkMcpToolsByAllowlist(
  tools: Tool[],
  allowlist: Set<string> | undefined,
): Tool[] {
  if (!allowlist) return tools
  return tools.filter(tool => {
    const upstreamName = tool.mcpInfo?.toolName
    return typeof upstreamName === 'string' && allowlist.has(upstreamName)
  })
}

// ============================================================================
// Default permission-denying canUseTool
// ============================================================================

/**
 * Module-level warning flag for default permissions.
 *
 * This warning fires ONCE PER PROCESS when the default fallback denial
 * actually executes (i.e., a tool is denied because no canUseTool callback was
 * provided). The warning is deferred to execution time so callers who provide
 * canUseTool never see it.
 *
 * If you create multiple queries/sessions in the same process, only the first
 * actual default denial will emit this warning. This behavior is acceptable because:
 * 1. The secure-by-default behavior applies to ALL instances
 * 2. Repeated warnings would be log noise without adding value
 * 3. The denial message per tool use already contains actionable guidance
 */
let warnedDefaultPermissions = false

/**
 * Default canUseTool that DENIES all tool uses when no explicit
 * canUseTool callback is provided.
 *
 * This is the secure-by-default behavior: SDK consumers must explicitly
 * provide a permission callback to allow tool execution. Permission modes
 * like 'bypass-permissions' still work because tool filtering happens at
 * the tool-list level via getTools(permissionContext) before this function
 * is ever reached.
 *
 * The warning is emitted at execution time (on first actual denial) rather
 * than at construction time, so callers who provide canUseTool never see false
 * warnings.
 */
export function createDefaultCanUseTool(
  _permissionContext: ToolPermissionContext,
  logger?: SDKLogger,
): CanUseToolFn {
  void logger
  return async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
    if (forceDecision) return forceDecision
    return hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseID)
  }
}

function sdkMcpToolMaxResultSizeChars(value: unknown): number {
  return typeof value === 'number' && (Number.isFinite(value) || value === Infinity)
    ? value
    : MCPTool.maxResultSizeChars
}

function sdkMcpToolErrorText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const text = content
      .map(block => {
        if (!block || typeof block !== 'object' || !('text' in block)) {
          return ''
        }
        const value = (block as { text?: unknown }).text
        return typeof value === 'string' ? value : ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) {
      return text
    }
  }
  return 'SDK MCP tool returned an error'
}
