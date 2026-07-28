import {
  getClaudeCodeMcpConfigs,
  isMcpServerDisabled,
} from '../../services/mcp/config.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import type { PluginError } from '../../types/plugin.js'

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
