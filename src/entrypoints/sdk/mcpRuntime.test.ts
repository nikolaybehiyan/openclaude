import { describe, expect, test } from 'bun:test'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { resolveSDKMcpServerConfigs } from './mcpRuntime.js'

describe('persistent SDK MCP runtime', () => {
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
          },
          errors: [],
        }
      },
      name => name === 'disabled',
    )

    expect(receivedDynamic).toBe(dynamic)
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
