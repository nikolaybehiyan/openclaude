import { describe, expect, test } from 'bun:test'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import {
  connectSDKMcpServersIncrementally,
  partitionSDKMcpServerConfigsForStartup,
  resolveSDKMcpServerConfigs,
} from './mcpRuntime.js'

describe('persistent SDK MCP runtime', () => {
  test('keeps in-process SDK tools on turn one and defers transport connections', () => {
    const sdkServer = { type: 'sdk', name: 'host-tools', tools: [] }
    const httpServer = { type: 'http', url: 'https://example.test/mcp' }
    const stdioServer = { type: 'stdio', command: 'node', args: ['server.js'] }

    expect(partitionSDKMcpServerConfigsForStartup({
      host: sdkServer,
      remote: httpServer,
      local: stdioServer,
    })).toEqual({
      immediate: { host: sdkServer },
      deferred: { remote: httpServer, local: stdioServer },
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
