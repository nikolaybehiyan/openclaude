import { basename, isAbsolute, join, normalize, resolve, sep } from 'path'
import { getAutoMemPath } from '../../memdir/paths.js'

export type MemoryStoreMode = 'rw' | 'ro'
export type MemoryStoreScope = 'user' | 'team'

export type MemoryStoreConfig = {
  path: string
  mode: MemoryStoreMode
  scope: MemoryStoreScope
  mount: string
  promptIndex?: string
  promptIndexMaxBytes?: number
  skillsDirs?: string[]
}

export type MemoryStoresConfigResult =
  | { active: false; stores: [] }
  | { active: true; stores: MemoryStoreConfig[]; error?: undefined }
  | { active: true; stores: []; error: string }

const MOUNT_RE = /^[A-Za-z0-9_-]+$/
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/
const MAX_SKILLS_DIRS = 10

let cachedRaw: string | undefined
let cachedResult: MemoryStoresConfigResult | undefined

function isSafeRelativePath(value: string): boolean {
  if (!value || isAbsolute(value) || value.includes('\\')) return false
  const normalized = value.normalize('NFC')
  if (normalized !== value) return false
  return value
    .split('/')
    .every(
      segment =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        SAFE_SEGMENT_RE.test(segment),
    )
}

function validateStorePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('path must be a non-empty string')
  }
  // Claude Code 2.1.221's ld_ predicate accepts any absolute, host-relative
  // URL whose resolution stays on the sentinel origin. Partition families are
  // server-owned, so the client must not hard-code /v1/code/memory here.
  if (!value.startsWith('/')) {
    throw new Error('path must be a host-relative absolute path')
  }
  try {
    if (new URL(value, 'https://sentinel.invalid').origin !== 'https://sentinel.invalid') {
      throw new Error('origin override')
    }
  } catch {
    throw new Error('path must be a host-relative absolute path')
  }
  return value.replace(/\/+$/, '') || '/'
}

function deriveMount(path: string): string {
  const candidate = basename(path).replace(/[^A-Za-z0-9_-]/g, '-')
  if (!candidate || candidate === '.' || candidate === '..') {
    throw new Error(`cannot derive a safe mount from path ${path}`)
  }
  return candidate
}

function parseObjectEntry(value: Record<string, unknown>): MemoryStoreConfig {
  const path = validateStorePath(value.path)
  const mode = value.mode ?? 'rw'
  const scope = value.scope ?? 'team'
  if (mode !== 'rw' && mode !== 'ro') {
    throw new Error('mode must be rw or ro')
  }
  if (scope !== 'user' && scope !== 'team') {
    throw new Error('scope must be user or team')
  }

  const mount = value.mount ?? deriveMount(path)
  if (typeof mount !== 'string' || !MOUNT_RE.test(mount)) {
    throw new Error('mount must match /^[A-Za-z0-9_-]+$/')
  }

  const promptIndex = value.promptIndex
  if (promptIndex !== undefined) {
    if (typeof promptIndex !== 'string' || !isSafeRelativePath(promptIndex)) {
      throw new Error('promptIndex must be a safe relative path')
    }
  }

  const promptIndexMaxBytes = value.promptIndexMaxBytes
  if (promptIndexMaxBytes !== undefined) {
    if (
      typeof promptIndexMaxBytes !== 'number' ||
      !Number.isInteger(promptIndexMaxBytes) ||
      promptIndexMaxBytes <= 0
    ) {
      throw new Error('promptIndexMaxBytes must be a positive integer')
    }
  }

  const skillsDirs = value.skillsDirs
  if (skillsDirs !== undefined) {
    if (!Array.isArray(skillsDirs) || skillsDirs.length > MAX_SKILLS_DIRS) {
      throw new Error(`skillsDirs must contain at most ${MAX_SKILLS_DIRS} paths`)
    }
    for (const dir of skillsDirs) {
      if (
        typeof dir !== 'string' ||
        !isSafeRelativePath(dir) ||
        dir.split('/').at(-1) !== 'skills'
      ) {
        throw new Error(
          "each skillsDirs entry must be a safe path ending in 'skills'",
        )
      }
    }
  }

  return {
    path,
    mode,
    scope,
    mount,
    ...(promptIndex !== undefined && { promptIndex }),
    ...(promptIndexMaxBytes !== undefined && { promptIndexMaxBytes }),
    ...(skillsDirs !== undefined && skillsDirs.length > 0 && { skillsDirs }),
  }
}

export function parseMemoryStores(raw: string): MemoryStoreConfig[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `CLAUDE_MEMORY_STORES is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!Array.isArray(value)) {
    throw new Error('CLAUDE_MEMORY_STORES must be a JSON array')
  }

  const stores: MemoryStoreConfig[] = []
  const mounts = new Set<string>()
  let hasUserStore = false
  for (const [index, entry] of value.entries()) {
    try {
      const parsed =
        typeof entry === 'string'
          ? parseObjectEntry({ path: entry })
          : entry !== null && typeof entry === 'object' && !Array.isArray(entry)
            ? parseObjectEntry(entry as Record<string, unknown>)
            : (() => {
                throw new Error('entry must be a path string or object')
              })()
      if (mounts.has(parsed.mount)) {
        throw new Error(`duplicate mount ${parsed.mount}`)
      }
      mounts.add(parsed.mount)
      if (parsed.scope === 'user') {
        if (hasUserStore) throw new Error('more than one scope:user entry')
        hasUserStore = true
      }
      stores.push(parsed)
    } catch (error) {
      throw new Error(
        `CLAUDE_MEMORY_STORES[${index}] failed validation: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return stores
}

export function getMemoryStoresConfig(): MemoryStoresConfigResult {
  const raw = process.env.CLAUDE_MEMORY_STORES
  if (raw === cachedRaw && cachedResult !== undefined) return cachedResult
  cachedRaw = raw
  if (!raw || raw.trim() === '') {
    cachedResult = { active: false, stores: [] }
    return cachedResult
  }
  try {
    cachedResult = { active: true, stores: parseMemoryStores(raw) }
  } catch (error) {
    cachedResult = {
      active: true,
      stores: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
  return cachedResult
}

export function hasConfiguredMemoryStores(): boolean {
  return Boolean(process.env.CLAUDE_MEMORY_STORES?.trim())
}

export function getMemoryStoreMountDir(store: MemoryStoreConfig): string {
  const autoMemoryRoot = getAutoMemPath().replace(/[\\/]+$/, '')
  return store.scope === 'user'
    ? autoMemoryRoot
    : join(autoMemoryRoot, 'team', store.mount)
}

export function isPathInsideMemoryStore(
  filePath: string,
  store: MemoryStoreConfig,
): boolean {
  const candidate = normalize(resolve(filePath))
  const root = normalize(resolve(getMemoryStoreMountDir(store)))
  return candidate === root || candidate.startsWith(root + sep)
}

export function resetMemoryStoresConfigForTesting(): void {
  cachedRaw = undefined
  cachedResult = undefined
}
