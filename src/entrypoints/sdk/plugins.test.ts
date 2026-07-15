import { describe, expect, test } from 'bun:test'
import { pluginRuntimeMarketplacesToRefresh } from './plugins.js'

const githubSource = { source: 'github' as const, repo: 'example/plugins' }

describe('plugin runtime marketplace refresh planning', () => {
  test('lets the reconciler clone a missing marketplace without a duplicate refresh', () => {
    expect(
      pluginRuntimeMarketplacesToRefresh({}, new Set(), {
        example: {
          source: githubSource,
          autoUpdate: true,
          revision: 'sha-1',
        },
      }),
    ).toEqual([])
  })

  test('refreshes an existing auto-update marketplace on SDK host startup', () => {
    expect(
      pluginRuntimeMarketplacesToRefresh({}, new Set(['example']), {
        example: {
          source: githubSource,
          autoUpdate: true,
          revision: 'sha-1',
        },
      }),
    ).toEqual(['example'])
  })

  test('refreshes a changed authoritative revision even when auto-update is off', () => {
    expect(
      pluginRuntimeMarketplacesToRefresh(
        { example: 'sha-1' },
        new Set(['example']),
        {
          example: {
            source: githubSource,
            autoUpdate: false,
            revision: 'sha-2',
          },
        },
      ),
    ).toEqual(['example'])
  })

  test('does not refresh an unchanged marketplace revision', () => {
    expect(
      pluginRuntimeMarketplacesToRefresh(
        { example: 'sha-1' },
        new Set(['example']),
        {
          example: {
            source: githubSource,
            autoUpdate: true,
            revision: 'sha-1',
          },
        },
      ),
    ).toEqual([])
  })
})
