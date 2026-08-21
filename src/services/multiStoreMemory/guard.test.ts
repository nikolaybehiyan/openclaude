import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { getAutoMemPath } from '../../memdir/paths.js'
import { resetMemoryStoresConfigForTesting } from './config.js'
import { checkMultiStoreMemoryWrite } from './guard.js'

const originalStores = process.env.CLAUDE_MEMORY_STORES
const originalOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE

function configure(root: string, stores: unknown[]): void {
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = root
  process.env.CLAUDE_MEMORY_STORES = JSON.stringify(stores)
  getAutoMemPath.cache?.clear?.()
  resetMemoryStoresConfigForTesting()
}

afterEach(() => {
  if (originalStores === undefined) delete process.env.CLAUDE_MEMORY_STORES
  else process.env.CLAUDE_MEMORY_STORES = originalStores
  if (originalOverride === undefined) {
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  } else {
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = originalOverride
  }
  getAutoMemPath.cache?.clear?.()
  resetMemoryStoresConfigForTesting()
})

describe('Claude Tag memory write guard', () => {
  test('is a no-op for ordinary chat sessions', () => {
    delete process.env.CLAUDE_MEMORY_STORES
    resetMemoryStoresConfigForTesting()
    expect(checkMultiStoreMemoryWrite('/tmp/MEMORY.md', 'ok')).toBeNull()
  })

  test('allows eligible writes only in rw mounts', () => {
    const root = '/tmp/openclaude-memory-guard'
    configure(root, [
      {
        path: '/v1/code/memory/team/shared',
        mode: 'rw',
        scope: 'team',
        mount: 'shared',
      },
      {
        path: '/v1/code/memory/team/reference',
        mode: 'ro',
        scope: 'team',
        mount: 'reference',
      },
    ])

    expect(
      checkMultiStoreMemoryWrite(
        join(root, 'team', 'shared', 'MEMORY.md'),
        'safe',
      ),
    ).toBeNull()
    expect(
      checkMultiStoreMemoryWrite(
        join(root, 'team', 'reference', 'MEMORY.md'),
        'safe',
      ),
    ).toContain('read-only')
    expect(
      checkMultiStoreMemoryWrite(join(root, 'other.md'), 'safe'),
    ).toContain('outside the Claude Tag memory stores')
  })

  test('rejects hidden, unsupported, oversized, and secret-bearing files', () => {
    const root = '/tmp/openclaude-memory-guard-policy'
    configure(root, [
      {
        path: '/v1/code/memory/users/me',
        mode: 'rw',
        scope: 'user',
        mount: 'private',
      },
    ])

    expect(
      checkMultiStoreMemoryWrite(join(root, '.hidden.md'), 'safe'),
    ).toContain('non-hidden')
    expect(checkMultiStoreMemoryWrite(join(root, 'memory.bin'), 'safe')).toContain(
      '.md, .txt, .json, or .jsonl',
    )
    expect(
      checkMultiStoreMemoryWrite(join(root, 'large.md'), 'x'.repeat(102_401)),
    ).toContain('102400 bytes')
    expect(
      checkMultiStoreMemoryWrite(
        join(root, 'secret.md'),
        `token: ghp_${'a'.repeat(36)}`,
      ),
    ).toContain('potential secret')
  })
})
