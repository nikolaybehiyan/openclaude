import { describe, expect, test } from 'bun:test'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Tool } from '../../Tool.js'
import {
  assembleSDKMcpAppState,
  connectSDKMcpServersIncrementally,
  nativePluginMcpToolReport,
  partitionSDKMcpServerConfigsForStartup,
  resolveSDKMcpServerConfigs,
} from './mcpRuntime.js'

describe('persistent SDK MCP runtime', () => {
  test('publishes pending clients and settled tools through interactive AppState', () => {
    const pending = { name: 'plugin:demo:server', type: 'pending' } as MCPServerConnection
    const tool = { name: 'mcp__plugin_demo_server__search' } as Tool
    const current = {
      clients: [],
      tools: [],
      commands: [{ name: 'unchanged-command' }],
      resources: { unchanged: [] },
      pluginReconnectKey: 7,
    } as unknown as AppState['mcp']

    const published = assembleSDKMcpAppState(
      current,
      new Map([['plugin:demo:server', [pending]]]),
      new Map([['plugin:demo:server', [tool]]]),
    )

    expect(published.clients).toEqual([pending])
    expect(published.tools).toEqual([tool])
    expect(published.commands).toBe(current.commands)
    expect(published.resources).toBe(current.resources)
    expect(published.pluginReconnectKey).toBe(7)
  })

  test('keeps in-process SDK tools on turn one and defers transport connections', () => {
    const sdkServer = { type: 'sdk', name: 'host-tools', tools: [] }
    const httpServer = { type: 'http', url: 'https://example.test/mcp' }
    const stdioServer = { type: 'stdio', command: 'node', args: ['server.js'] }
    const pluginPersisted = {
      type: 'plugin_persisted',
      persistedTools: [{ name: 'search', inputSchema: { type: 'object' } }],
    }

    expect(partitionSDKMcpServerConfigsForStartup({
      host: sdkServer,
      remote: httpServer,
      local: stdioServer,
      'plugin:demo:search': pluginPersisted,
    })).toEqual({
      immediate: { host: sdkServer },
      deferred: { remote: httpServer, local: stdioServer },
      pluginPersisted: { 'plugin:demo:search': pluginPersisted },
    })
  })

  test('publishes a fast MCP without waiting for a slow server to settle', async () => {
    let releaseSlow!: () => void
    const slow = new Promise<void>(resolve => {
      releaseSlow = resolve
    })
    const settled: string[] = []
    let fastPublished!: () => void
    const fastWasPublished = new Promise<void>(resolve => {
      fastPublished = resolve
    })

    const completion = connectSDKMcpServersIncrementally(
      { slow: {}, fast: {} },
      async name => {
        if (name === 'slow') await slow
        return `${name}-tools`
      },
      name => {
        settled.push(name)
        if (name === 'fast') fastPublished()
      },
    )

    await fastWasPublished
    expect(settled).toEqual(['fast'])
    releaseSlow()
    await completion
    expect(settled).toEqual(['fast', 'slow'])
  })

  test('reports exact native plugin tool identity and JSON schema without reporting host connectors', () => {
    const tool = {
      name: 'mcp__plugin_demo_research__search',
      mcpInfo: { serverName: 'plugin:demo:research', toolName: 'search' },
      inputJSONSchema: { type: 'object', properties: { query: { type: 'string' } } },
      searchHint: 'papers evidence',
      alwaysLoad: true,
      _meta: { 'anthropic/alwaysLoad': true },
    } as unknown as Tool

    expect(nativePluginMcpToolReport('plugin:demo:research', [tool])).toEqual({
      serverName: 'plugin:demo:research',
      tools: [{
        name: 'search',
        description: '',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        searchHint: 'papers evidence',
        alwaysLoad: true,
        _meta: { 'anthropic/alwaysLoad': true },
      }],
    })
    expect(nativePluginMcpToolReport('pubmed', [tool])).toBeNull()
  })

  test('uses the native loader and merges host dynamic servers with highest precedence', async () => {
    const dynamic = {
      host: { type: 'sdk', name: 'host' },
      shared: { type: 'sdk', name: 'host-shared' },
    }
    let receivedDynamic: Record<string, ScopedMcpServerConfig> | undefined

    const result = await resolveSDKMcpServerConfigs(
      dynamic,
      async configs => {
        receivedDynamic = configs
        return {
          servers: {
            'plugin:forge:governance': {
              type: 'stdio',
              command: 'node',
              args: ['server.js'],
              scope: 'dynamic',
              pluginSource: 'nxtg-forge@nxtg-ai',
            },
            shared: {
              type: 'stdio',
              command: 'plugin-shared',
              scope: 'dynamic',
            },
            disabled: {
              type: 'stdio',
              command: 'disabled-server',
              scope: 'dynamic',
            },
          } as unknown as Record<string, ScopedMcpServerConfig>,
          errors: [],
        }
      },
      name => name === 'disabled',
    )

    expect(receivedDynamic as unknown).toBe(dynamic)
    expect(result.servers).toEqual({
      'plugin:forge:governance': {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        scope: 'dynamic',
        pluginSource: 'nxtg-forge@nxtg-ai',
      },
      host: { type: 'sdk', name: 'host' },
      shared: { type: 'sdk', name: 'host-shared' },
    })
  })
})
