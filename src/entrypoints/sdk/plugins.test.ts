import { describe, expect, test } from 'bun:test'
import {
  applySDKLocalPlugins,
  pluginProjectionFromLoadedPlugins,
  pluginRuntimeMarketplacesToRefresh,
  pluginSkillProjectionFromLoadedPlugins,
} from './plugins.js'
import { getInlinePlugins, setInlinePlugins } from '../../bootstrap/state.js'

const githubSource = { source: 'github' as const, repo: 'example/plugins' }

describe('official SDK local plugins', () => {
  test('normalizes local roots and updates the native inline loader only on change', () => {
    const previous = [...getInlinePlugins()]
    try {
      setInlinePlugins([])
      expect(applySDKLocalPlugins([
        { type: 'local', path: '/tmp/plugin-b' },
        { type: 'local', path: '/tmp/plugin-a' },
        { type: 'local', path: '/tmp/plugin-b' },
      ])).toEqual({
        paths: ['/tmp/plugin-a', '/tmp/plugin-b'],
        changed: true,
      })
      expect(getInlinePlugins()).toEqual(['/tmp/plugin-a', '/tmp/plugin-b'])
      expect(applySDKLocalPlugins([
        { type: 'local', path: '/tmp/plugin-a' },
        { type: 'local', path: '/tmp/plugin-b' },
      ])).toEqual({
        paths: ['/tmp/plugin-a', '/tmp/plugin-b'],
        changed: false,
      })
    } finally {
      setInlinePlugins(previous)
    }
  })

  test('rejects malformed local plugin entries', () => {
    expect(() => applySDKLocalPlugins([
      { type: 'local', path: ' ' },
    ])).toThrow('plugins[0].path must be non-empty')
  })
})

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

describe('plugin runtime skill projection', () => {
  test('returns every enabled plugin root for remote runtime projection', () => {
    expect(
      pluginProjectionFromLoadedPlugins([
        {
          name: 'design',
          source: 'official',
          path: '/cache/design',
          manifest: { name: 'design' },
          repository: 'official',
          skillsPath: '/cache/design/skills',
        },
        {
          name: 'mcp-only',
          source: 'official',
          path: '/cache/mcp-only',
          manifest: { name: 'mcp-only' },
          repository: 'official',
        },
      ]),
    ).toEqual([
      {
        name: 'design',
        source: 'official',
        pluginRoot: '/cache/design',
        skillRoots: ['/cache/design/skills'],
      },
      {
        name: 'mcp-only',
        source: 'official',
        pluginRoot: '/cache/mcp-only',
        skillRoots: [],
      },
    ])
  })

  test('returns only native skill roots from enabled loaded plugins', () => {
    expect(
      pluginSkillProjectionFromLoadedPlugins([
        {
          name: 'design',
          source: 'official',
          path: '/cache/design',
          manifest: { name: 'design' },
          repository: 'official',
          skillsPath: '/cache/design/skills',
          skillsPaths: [
            '/cache/design/extra-skills',
            '/cache/design/skills',
          ],
        },
        {
          name: 'mcp-only',
          source: 'official',
          path: '/cache/mcp-only',
          manifest: { name: 'mcp-only' },
          repository: 'official',
        },
      ]),
    ).toEqual([
      {
        name: 'design',
        source: 'official',
        pluginRoot: '/cache/design',
        skillRoots: [
          '/cache/design/extra-skills',
          '/cache/design/skills',
        ],
      },
    ])
  })
})
