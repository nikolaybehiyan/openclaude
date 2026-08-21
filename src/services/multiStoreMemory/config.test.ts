import { afterEach, describe, expect, test } from 'bun:test'
import {
  getMemoryStoresConfig,
  parseMemoryStores,
  resetMemoryStoresConfigForTesting,
} from './config.js'

const originalMemoryStores = process.env.CLAUDE_MEMORY_STORES

afterEach(() => {
  if (originalMemoryStores === undefined) delete process.env.CLAUDE_MEMORY_STORES
  else process.env.CLAUDE_MEMORY_STORES = originalMemoryStores
  resetMemoryStoresConfigForTesting()
})

describe('CLAUDE_MEMORY_STORES parser', () => {
  test('uses the 2.1.221 defaults for path strings', () => {
    expect(parseMemoryStores('["/v1/code/memory/partitions/shared"]')).toEqual([
      {
        path: '/v1/code/memory/partitions/shared',
        mode: 'rw',
        scope: 'team',
        mount: 'shared',
      },
    ])
  })

  test('accepts server-defined host-relative partition families', () => {
    expect(parseMemoryStores('["/custom/memory/partition"]')).toEqual([
      {
        path: '/custom/memory/partition',
        mode: 'rw',
        scope: 'team',
        mount: 'partition',
      },
    ])
  })

  test('preserves validated optional metadata', () => {
    expect(
      parseMemoryStores(
        JSON.stringify([
          {
            path: '/v1/code/memory/users/me',
            mode: 'ro',
            scope: 'user',
            mount: 'private',
            promptIndex: 'indexes/MEMORY.md',
            promptIndexMaxBytes: 4096,
            skillsDirs: ['account/skills'],
          },
        ]),
      ),
    ).toEqual([
      {
        path: '/v1/code/memory/users/me',
        mode: 'ro',
        scope: 'user',
        mount: 'private',
        promptIndex: 'indexes/MEMORY.md',
        promptIndexMaxBytes: 4096,
        skillsDirs: ['account/skills'],
      },
    ])
  })

  test('rejects duplicate mounts and multiple private stores', () => {
    expect(() =>
      parseMemoryStores(
        JSON.stringify([
          '/v1/code/memory/a/shared',
          '/v1/code/memory/b/shared',
        ]),
      ),
    ).toThrow('duplicate mount shared')

    expect(() =>
      parseMemoryStores(
        JSON.stringify([
          { path: '/v1/code/memory/users/a', scope: 'user' },
          { path: '/v1/code/memory/users/b', scope: 'user' },
        ]),
      ),
    ).toThrow('more than one scope:user entry')
  })

  test('rejects host overrides and unsafe prompt or skill paths', () => {
    expect(() =>
      parseMemoryStores('["https://evil.example/v1/code/memory/x"]'),
    ).toThrow('host-relative')
    expect(() =>
      parseMemoryStores(
        JSON.stringify([
          {
            path: '/v1/code/memory/x',
            promptIndex: '../MEMORY.md',
          },
        ]),
      ),
    ).toThrow('safe relative path')
    expect(() =>
      parseMemoryStores(
        JSON.stringify([
          { path: '/v1/code/memory/x', skillsDirs: ['skills/cache'] },
        ]),
      ),
    ).toThrow("ending in 'skills'")
  })

  test('does not activate when unset and fails closed when invalid', () => {
    delete process.env.CLAUDE_MEMORY_STORES
    resetMemoryStoresConfigForTesting()
    expect(getMemoryStoresConfig()).toEqual({ active: false, stores: [] })

    process.env.CLAUDE_MEMORY_STORES = '{bad json'
    resetMemoryStoresConfigForTesting()
    const invalid = getMemoryStoresConfig()
    expect(invalid.active).toBe(true)
    expect(invalid.stores).toEqual([])
    expect('error' in invalid).toBe(true)
  })
})
