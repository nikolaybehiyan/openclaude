import {
  getClaudeCodeMcpConfigs,
  isMcpServerDisabled,
} from '../../services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Tool } from '../../Tool.js'
import type { PluginError } from '../../types/plugin.js'

export type SDKMcpServerConfigPartitions = {
  immediate: Record<string, unknown>
  deferred: Record<string, unknown>
  pluginPersisted: Record<string, unknown>
}

export type SDKMcpIncrementalSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

/**
 * Publish the SDK-owned MCP runtime through the same AppState surface used by
 * interactive OpenClaude. Keeping pending clients here is important: the
 * model request retains ToolSearch while live servers are still connecting,
 * and newly-settled tools are visible to the next agent-loop step.
 */
export function assembleSDKMcpAppState(
  current: AppState['mcp'],
  clientsByServer: ReadonlyMap<string, readonly MCPServerConnection[]>,
  toolsByServer: ReadonlyMap<string, readonly Tool[]>,
): AppState['mcp'] {
  return {
    ...current,
    clients: [...clientsByServer.values()].flat(),
    tools: [...toolsByServer.values()].flat(),
  }
}

/**
 * In-process SDK servers are JavaScript tool definitions and never open a
 * transport. Install them before turn one. HTTP/SSE/stdio servers connect in
 * the background so one slow native MCP cannot delay the first model request.
 */
export function partitionSDKMcpServerConfigsForStartup(
  configs: Record<string, unknown> = {},
): SDKMcpServerConfigPartitions {
  const immediate: Record<string, unknown> = {}
  const deferred: Record<string, unknown> = {}
  const pluginPersisted: Record<string, unknown> = {}
  for (const [name, config] of Object.entries(configs)) {
    if (
      config !== null &&
      typeof config === 'object' &&
      !Array.isArray(config) &&
      (config as Record<string, unknown>).type === 'plugin_persisted'
    ) {
      pluginPersisted[name] = config
      continue
    }
    if (
      config !== null &&
      typeof config === 'object' &&
      !Array.isArray(config) &&
      (config as Record<string, unknown>).type === 'sdk'
    ) {
      immediate[name] = config
    } else {
      deferred[name] = config
    }
  }
  return { immediate, deferred, pluginPersisted }
}

/**
 * Connect every transport independently and publish it as soon as it settles.
 * Callers may await immediate SDK configs while fire-and-forgetting deferred
 * transports; no Promise.all barrier is exposed to the model path.
 */
export async function connectSDKMcpServersIncrementally<T>(
  configs: Record<string, unknown>,
  connectOne: (name: string, config: unknown) => Promise<T>,
  onSettled: (name: string, settlement: SDKMcpIncrementalSettlement<T>) => void | Promise<void>,
): Promise<void> {
  await Promise.allSettled(
    Object.entries(configs).map(async ([name, config]) => {
      let settlement: SDKMcpIncrementalSettlement<T>
      try {
        settlement = { status: 'fulfilled', value: await connectOne(name, config) }
      } catch (reason) {
        settlement = { status: 'rejected', reason }
      }
      await onSettled(name, settlement)
    }),
  )
}

type LoadClaudeCodeMcpConfigs = (
  dynamicServers: Record<string, ScopedMcpServerConfig>,
) => Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}>

/**
 * Resolve MCP configs for a persistent SDK session through OpenClaude's
 * native MCP/plugin loader. The loader owns plugin discovery, environment
 * expansion, policy filtering, namespacing, and duplicate suppression.
 * Host-provided SDK servers remain the highest-precedence dynamic configs,
 * matching the native useManageMCPConnections path.
 */
export async function resolveSDKMcpServerConfigs(
  dynamicServers: Record<string, unknown> = {},
  loadConfigs: LoadClaudeCodeMcpConfigs = getClaudeCodeMcpConfigs,
  isDisabled: (name: string) => boolean = isMcpServerDisabled,
): Promise<{
  servers: Record<string, unknown>
  errors: PluginError[]
}> {
  const dynamic = dynamicServers as Record<string, ScopedMcpServerConfig>
  const { servers: claudeCodeServers, errors } = await loadConfigs(dynamic)
  const merged = { ...claudeCodeServers, ...dynamicServers }
  return {
    servers: Object.fromEntries(
      Object.entries(merged).filter(([name]) => !isDisabled(name)),
    ),
    errors,
  }
}
