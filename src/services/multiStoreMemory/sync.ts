import { createHash, randomUUID } from 'crypto'
import { watch, type FSWatcher } from 'chokidar'
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'path'
import { addSkillDirectories } from '../../skills/loadSkillsDir.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { scanForSecrets } from '../teamMemorySync/secretScanner.js'
import {
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryServiceError,
  MemoryServiceBackend,
  type RemoteMemoryEntry,
  type RemoteMemoryDocument,
} from './backend.js'
import {
  getMemoryStoreMountDir,
  getMemoryStoresConfig,
  hasConfiguredMemoryStores,
  type MemoryStoreConfig,
} from './config.js'

const MANIFEST_NAME = '.memory-sync'
const BASIS_NAME = '.memory-sync-basis'
const MANIFEST_VERSION = 1
const BASIS_VERSION = 1
const MAX_FILE_BYTES = 102_400
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.jsonl'])
const FIRST_PULL_DEADLINE_MS = 2_500
const DELETE_CONFIRMATION_MS = 30_000
const DEFAULT_PERIODIC_SYNC_MINUTES = 60
const MAX_CONCURRENT_IO = 6
const MASS_DELETE_MINIMUM = 50
const WATCH_DEBOUNCE_MS = 2_000
const DELETE_RECHECK_MS = DELETE_CONFIRMATION_MS + 5_000
const PERMANENT_FAILURE_LIMIT = 3
const PERMANENT_FAILURE_RETRY_MS = 5 * 60 * 1000

type LocalEntry = {
  path: string
  content: string
  sha256: string
}

type BasisEntry = {
  id: string
  sha256: string
}

type PendingDelete = {
  firstMissingAtMs: number
  missingWalks: number
}

export type MultiStoreMemoryBackend = {
  mode: MemoryStoreConfig['mode']
  partitionId: string
  label: string
  list(options?: {
    pathPrefix?: string
    depthOne?: boolean
  }): Promise<RemoteMemoryEntry[]>
  read(id: string): Promise<RemoteMemoryDocument>
  readByPath(path: string): Promise<RemoteMemoryDocument | null>
  create(path: string, content: string): Promise<RemoteMemoryEntry>
  update(
    entry: RemoteMemoryEntry,
    content: string,
  ): Promise<RemoteMemoryEntry>
  delete(entry: RemoteMemoryEntry): Promise<void>
  getExportUrl(metadataOnly?: boolean): string
}

type StoreController = {
  store: MemoryStoreConfig
  backend: MultiStoreMemoryBackend
  mountDir: string
  remote: Map<string, RemoteMemoryEntry>
  basis: Map<string, BasisEntry>
  pendingDeletes: Map<string, PendingDelete>
  pulled: boolean
  suppressedReason: string | null
  suppressedUntilMs: number | null
  permanentFailureCount: number
}

type RuntimeState = {
  raw: string
  controllers: StoreController[]
  error?: string
}

let runtimeState: RuntimeState | null = null
let inFlightSync: Promise<void> | null = null
let periodicTimer: ReturnType<typeof setInterval> | null = null
let cleanupRegistered = false
let unregisterCleanup: (() => void) | null = null
let fileWatcher: FSWatcher | null = null
let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null
let deleteRecheckTimer: ReturnType<typeof setTimeout> | null = null
const defaultBackendFactory = (store: MemoryStoreConfig): MultiStoreMemoryBackend =>
  new MemoryServiceBackend(store)
let backendFactory = defaultBackendFactory

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function comparableHash(value: string): string {
  return value.replace(/^sha256:/, '').toLowerCase()
}

function hashesEqual(left: string, right: string): boolean {
  return comparableHash(left) === comparableHash(right)
}

function normalizeMemoryPath(path: string): string | null {
  const stripped = path.replace(/^\/+/, '')
  const segments = stripped.split('/')
  if (
    !stripped ||
    path.includes('\\') ||
    path.normalize('NFC') !== path ||
    segments.some(
      segment =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.startsWith('.') ||
        /[\u0000-\u001f\u007f]/.test(segment),
    ) ||
    !ALLOWED_EXTENSIONS.has(extname(segments.at(-1) ?? '').toLowerCase())
  ) {
    return null
  }
  return '/' + stripped
}

function localPathFor(controller: StoreController, remotePath: string): string {
  const normalized = normalizeMemoryPath(remotePath)
  if (!normalized) throw new Error(`unsafe memory path ${remotePath}`)
  const candidate = resolve(controller.mountDir, normalized.slice(1))
  const root = resolve(controller.mountDir)
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`memory path escapes mount ${controller.store.mount}`)
  }
  return candidate
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const stage = `${path}.${randomUUID()}.stage`
  try {
    await writeFile(stage, content, 'utf8')
    await rename(stage, path)
  } finally {
    await unlink(stage).catch(() => {})
  }
}

async function ensureCanonicalMount(controller: StoreController): Promise<void> {
  await mkdir(controller.mountDir, { recursive: true })
  const autoRoot = getMemoryStoreMountDir({
    ...controller.store,
    scope: 'user',
  })
  await mkdir(autoRoot, { recursive: true })
  const realRoot = await realpath(autoRoot)
  const realMount = await realpath(controller.mountDir)
  if (
    controller.store.scope === 'team' &&
    realMount !== realRoot &&
    !realMount.startsWith(realRoot + sep)
  ) {
    throw new Error(`mount ${controller.store.mount} escapes auto-memory root`)
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return undefined
    }
    throw error
  }
}

async function readManifestState(path: string): Promise<
  | { state: 'absent' }
  | { state: 'torn' }
  | { state: 'present'; partition: string }
> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { state: 'absent' }
    }
    return { state: 'torn' }
  }
  try {
    const value = JSON.parse(raw) as unknown
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).v === MANIFEST_VERSION &&
      typeof (value as Record<string, unknown>).partition === 'string'
    ) {
      return {
        state: 'present',
        partition: (value as Record<string, string>).partition,
      }
    }
  } catch {
    // A malformed manifest is a torn file, not a foreign partition.
  }
  return { state: 'torn' }
}

async function ensureManifest(controller: StoreController): Promise<void> {
  const manifestPath = join(controller.mountDir, MANIFEST_NAME)
  const existing = await readManifestState(manifestPath)
  if (
    existing.state === 'present' &&
    existing.partition === controller.backend.partitionId
  ) {
    return
  }
  if (existing.state === 'present' && controller.store.scope !== 'user') {
    throw new Error(
      `mount ${controller.store.mount} holds another store's ${MANIFEST_NAME}`,
    )
  }

  // CLAUDE_MEMORY_STORES entries have source="env" in 2.1.221. The server is
  // authoritative for that binding, so an absent manifest is materialized
  // even when the mount contains files. Content-match adoption is required
  // only for separately discovered stores, which this module does not own.

  const content = JSON.stringify({
    v: MANIFEST_VERSION,
    partition: controller.backend.partitionId,
  })
  if (existing.state !== 'absent') {
    // User mounts are rebound by the host, and torn env manifests are
    // materialized. A proper foreign team manifest was rejected above.
    await atomicWrite(manifestPath, content)
    return
  }
  try {
    await writeFile(manifestPath, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error
    }
    const raced = await readManifestState(manifestPath)
    if (
      raced.state !== 'present' ||
      raced.partition !== controller.backend.partitionId
    ) {
      throw new Error(
        `mount ${controller.store.mount} manifest changed during initialization`,
      )
    }
  }
}

async function loadBasis(controller: StoreController): Promise<void> {
  const raw = await readJson(join(controller.mountDir, BASIS_NAME))
  if (
    raw === undefined ||
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw)
  ) {
    return
  }
  const record = raw as Record<string, unknown>
  if (
    record.v !== BASIS_VERSION ||
    record.partition !== controller.backend.partitionId ||
    !Array.isArray(record.entries) ||
    !Array.isArray(record.deletes)
  ) {
    return
  }
  for (const item of record.entries) {
    if (
      Array.isArray(item) &&
      item.length === 3 &&
      typeof item[0] === 'string' &&
      typeof item[1] === 'string' &&
      typeof item[2] === 'string' &&
      normalizeMemoryPath(item[0]) !== null
    ) {
      controller.basis.set(normalizeMemoryPath(item[0])!, {
        id: item[1],
        sha256: item[2],
      })
    }
  }
  const loadedAtMs = Date.now()
  for (const item of record.deletes) {
    if (
      Array.isArray(item) &&
      item.length === 3 &&
      typeof item[0] === 'string' &&
      typeof item[1] === 'number' &&
      Number.isFinite(item[1]) &&
      typeof item[2] === 'number' &&
      Number.isInteger(item[2]) &&
      item[2] > 0
    ) {
      const path = normalizeMemoryPath(item[0])
      if (path) {
        controller.pendingDeletes.set(path, {
          // 2.1.221 persists the pending marker but deliberately restarts the
          // confirmation clock after a process restart. A stale basis file
          // must never turn one missing disk walk into an immediate delete.
          firstMissingAtMs: loadedAtMs,
          missingWalks: Math.max(0, Math.min(item[2], 1)),
        })
      }
    }
  }
}

async function persistBasis(controller: StoreController): Promise<void> {
  const manifest = await readJson(join(controller.mountDir, MANIFEST_NAME))
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    (manifest as Record<string, unknown>).partition !==
      controller.backend.partitionId
  ) {
    throw new Error(`refusing basis write for foreign mount ${controller.store.mount}`)
  }
  const body = JSON.stringify({
    v: BASIS_VERSION,
    partition: controller.backend.partitionId,
    entries: [...controller.remote.values()].map(entry => [
      entry.path,
      entry.id,
      entry.sha256,
    ]),
    deletes: [...controller.pendingDeletes].map(([path, pending]) => [
      path,
      pending.firstMissingAtMs,
      pending.missingWalks,
    ]),
  })
  await atomicWrite(join(controller.mountDir, BASIS_NAME), body)
  controller.basis = new Map(
    [...controller.remote.values()].map(entry => [
      entry.path,
      { id: entry.id, sha256: entry.sha256 },
    ]),
  )
}

async function invalidateBasis(controller: StoreController): Promise<void> {
  controller.basis.clear()
  controller.pendingDeletes.clear()
  controller.pulled = false
  await atomicWrite(
    join(controller.mountDir, BASIS_NAME),
    JSON.stringify({
      v: BASIS_VERSION,
      partition: controller.backend.partitionId,
      entries: [],
      deletes: [],
    }),
  )
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= values.length) return
      await operation(values[index]!)
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  )
}

async function scanLocal(controller: StoreController): Promise<{
  entries: Map<string, LocalEntry>
  diskPaths: Set<string>
  skippedSecrets: string[]
}> {
  const entries = new Map<string, LocalEntry>()
  const diskPaths = new Set<string>()
  const skippedSecrets: string[] = []

  async function walk(dir: string): Promise<void> {
    let children
    try {
      children = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return
      }
      throw error
    }
    for (const child of children) {
      if (child.name.startsWith('.')) continue
      // A scope:user store owns the private root. Team mounts live below the
      // sibling team/ directory and must never be folded into the user store.
      if (
        controller.store.scope === 'user' &&
        dir === controller.mountDir &&
        child.name === 'team'
      ) {
        continue
      }
      const absolute = join(dir, child.name)
      if (child.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!child.isFile()) continue
      const relativePath = relative(controller.mountDir, absolute)
        .split(sep)
        .join('/')
      const memoryPath = normalizeMemoryPath(relativePath)
      if (!memoryPath) continue
      diskPaths.add(memoryPath)
      const info = await stat(absolute)
      if (info.size > MAX_FILE_BYTES) {
        logForDebugging(
          `multi-store-memory[${controller.store.mount}]: skipping oversized ${memoryPath}`,
          { level: 'warn' },
        )
        continue
      }
      const content = await readFile(absolute, 'utf8')
      if (scanForSecrets(content).length > 0) {
        skippedSecrets.push(memoryPath)
        logForDebugging(
          `multi-store-memory[${controller.store.mount}]: skipping secret-bearing ${memoryPath}`,
          { level: 'warn' },
        )
        continue
      }
      entries.set(memoryPath, {
        path: memoryPath,
        content,
        sha256: localHash(content),
      })
    }
  }

  await walk(controller.mountDir)
  return { entries, diskPaths, skippedSecrets }
}

async function pullStore(controller: StoreController): Promise<void> {
  let listed: RemoteMemoryEntry[]
  try {
    listed = await controller.backend.list()
  } catch (error) {
    if (error instanceof MemoryNotFoundError) listed = []
    else throw error
  }

  const remote = new Map<string, RemoteMemoryEntry>()
  const ids = new Map<string, string>()
  for (const entry of listed) {
    const path = normalizeMemoryPath(entry.path)
    if (!path) continue
    if (ids.has(entry.id) && ids.get(entry.id) !== path) continue
    ids.set(entry.id, path)
    remote.set(path, { ...entry, path })
  }

  const local = await scanLocal(controller)
  await mapConcurrent(
    [...remote.values()],
    MAX_CONCURRENT_IO,
    async entry => {
      const localEntry = local.entries.get(entry.path)
      if (localEntry && hashesEqual(localEntry.sha256, entry.sha256)) return

      const basis = controller.basis.get(entry.path)
      const localWasDeleted = !local.diskPaths.has(entry.path)
      if (
        controller.store.mode === 'rw' &&
        localWasDeleted &&
        basis &&
        hashesEqual(basis.sha256, entry.sha256)
      ) {
        return
      }
      if (
        controller.store.mode === 'rw' &&
        localEntry &&
        basis &&
        !hashesEqual(localEntry.sha256, basis.sha256)
      ) {
        if (!hashesEqual(entry.sha256, basis.sha256)) {
          logForDebugging(
            `multi-store-memory[${controller.store.mount}]: preserving local concurrent change ${entry.path}`,
            { level: 'warn' },
          )
        }
        return
      }

      const document = await controller.backend.read(entry.id)
      await atomicWrite(localPathFor(controller, entry.path), document.content)
    },
  )

  for (const [path, basis] of controller.basis) {
    if (remote.has(path)) continue
    const localEntry = local.entries.get(path)
    if (
      controller.store.mode === 'ro' ||
      (localEntry && hashesEqual(localEntry.sha256, basis.sha256))
    ) {
      await unlink(localPathFor(controller, path)).catch(error => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      })
    }
  }

  controller.remote = remote
  controller.pulled = true
}

async function recoverConflict(
  controller: StoreController,
  entry: RemoteMemoryEntry,
): Promise<void> {
  try {
    const current = await controller.backend.read(entry.id)
    await atomicWrite(localPathFor(controller, entry.path), current.content)
    controller.remote.set(entry.path, {
      id: entry.id,
      path: entry.path,
      sha256: current.sha256,
    })
    logForDebugging(
      `multi-store-memory[${controller.store.mount}]: restored server version after conflict on ${entry.path}`,
      { level: 'warn' },
    )
  } catch (error) {
    logForDebugging(
      `multi-store-memory[${controller.store.mount}]: conflict recovery failed for ${entry.path}: ${errorMessage(error)}`,
      { level: 'warn' },
    )
  }
}

async function pushStore(
  controller: StoreController,
  allowDeletes: boolean,
): Promise<void> {
  if (!controller.pulled || controller.store.mode === 'ro') {
    await persistBasis(controller)
    return
  }

  const local = await scanLocal(controller)
  await mapConcurrent(
    [...local.entries.values()],
    MAX_CONCURRENT_IO,
    async entry => {
      const known = controller.remote.get(entry.path)
      if (known && hashesEqual(known.sha256, entry.sha256)) return
      try {
        let saved: RemoteMemoryEntry
        if (known) {
          try {
            saved = await controller.backend.update(known, entry.content)
          } catch (error) {
            if (!(error instanceof MemoryNotFoundError)) throw error
            // A disappeared id is recreated only after proving the path is
            // now absent. If another id owns it, the next pull resolves it.
            if ((await controller.backend.readByPath(entry.path)) !== null) {
              throw error
            }
            controller.remote.delete(entry.path)
            saved = await controller.backend.create(entry.path, entry.content)
          }
        } else {
          try {
            saved = await controller.backend.create(entry.path, entry.content)
          } catch (error) {
            // 2.1.221 uses a same-path conflicting id as an optimistic create
            // race: read its current SHA, then update it with the local edit.
            if (!(error instanceof MemoryConflictError) || !error.existingId) {
              throw error
            }
            const current = await controller.backend.read(error.existingId)
            saved = await controller.backend.update(
              {
                id: error.existingId,
                path: entry.path,
                sha256: current.sha256,
              },
              entry.content,
            )
          }
        }
        controller.remote.set(entry.path, { ...saved, path: entry.path })
        controller.pendingDeletes.delete(entry.path)
      } catch (error) {
        if (error instanceof MemoryConflictError) {
          const conflictEntry =
            known ??
            (error.existingId
              ? {
                  id: error.existingId,
                  path: entry.path,
                  sha256: '',
                }
              : undefined)
          if (conflictEntry) await recoverConflict(controller, conflictEntry)
          return
        }
        throw error
      }
    },
  )

  const now = Date.now()
  const missing = [...controller.remote.values()].filter(
    entry => !local.diskPaths.has(entry.path),
  )
  const massDeleteLimit = Math.max(
    MASS_DELETE_MINIMUM,
    Math.floor(controller.remote.size * 0.1),
  )
  const deleteMode =
    process.env.CLAUDE_CODE_MEMORY_PUSH_DELETE_MODE ??
    getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_mem_push_delete_mode',
      'corroborate',
    )
  const eligibleDeletes: RemoteMemoryEntry[] = []
  if (allowDeletes && deleteMode !== 'never') {
    for (const entry of missing) {
      if (deleteMode === 'immediate') {
        eligibleDeletes.push(entry)
        continue
      }
      const pending = controller.pendingDeletes.get(entry.path)
      if (!pending) {
        controller.pendingDeletes.set(entry.path, {
          firstMissingAtMs: now,
          missingWalks: 1,
        })
        continue
      }
      pending.missingWalks++
      if (
        pending.missingWalks >= 2 &&
        now - pending.firstMissingAtMs >= DELETE_CONFIRMATION_MS
      ) {
        eligibleDeletes.push(entry)
      }
    }
  }
  if (
    eligibleDeletes.length > 0 &&
    missing.length > massDeleteLimit &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MEMORY_MASS_DELETE_HOLD)
  ) {
    logForDebugging(
      `multi-store-memory[${controller.store.mount}]: holding ${missing.length} deletes behind mass-delete guard`,
      { level: 'warn' },
    )
    await invalidateBasis(controller)
    return
  }
  await mapConcurrent(
    eligibleDeletes,
    MAX_CONCURRENT_IO,
    async entry => {
      try {
        await controller.backend.delete(entry)
        controller.remote.delete(entry.path)
        controller.pendingDeletes.delete(entry.path)
      } catch (error) {
        if (error instanceof MemoryNotFoundError) {
          controller.remote.delete(entry.path)
          controller.pendingDeletes.delete(entry.path)
          return
        }
        if (error instanceof MemoryConflictError) {
          await recoverConflict(controller, entry)
          controller.pendingDeletes.delete(entry.path)
          return
        }
        throw error
      }
    },
  )
  for (const path of [...controller.pendingDeletes.keys()]) {
    if (local.diskPaths.has(path) || !controller.remote.has(path)) {
      controller.pendingDeletes.delete(path)
    }
  }

  await persistBasis(controller)
}

function isManifestSuppression(reason: string): boolean {
  return (
    reason.includes(MANIFEST_NAME) ||
    reason.includes('unmanifested and non-empty')
  )
}

async function manifestSuppressionCleared(
  controller: StoreController,
): Promise<boolean> {
  await ensureCanonicalMount(controller)
  const existing = await readJson(join(controller.mountDir, MANIFEST_NAME))
  if (existing !== undefined) {
    return (
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      (existing as Record<string, unknown>).v === MANIFEST_VERSION &&
      (existing as Record<string, unknown>).partition ===
        controller.backend.partitionId
    )
  }
  return (
    controller.store.scope !== 'team' ||
    (await readdir(controller.mountDir)).length === 0
  )
}

async function syncController(
  controller: StoreController,
  allowDeletes: boolean,
): Promise<void> {
  if (controller.suppressedReason) {
    if (
      controller.suppressedUntilMs !== null &&
      Date.now() >= controller.suppressedUntilMs
    ) {
      controller.suppressedReason = null
      controller.suppressedUntilMs = null
    } else if (
      isManifestSuppression(controller.suppressedReason) &&
      (await manifestSuppressionCleared(controller).catch(() => false))
    ) {
      controller.suppressedReason = null
    } else {
      return
    }
  }
  try {
    await ensureCanonicalMount(controller)
    await ensureManifest(controller)
    if (controller.basis.size === 0) await loadBasis(controller)
    await pullStore(controller)
    await pushStore(controller, allowDeletes)
    controller.permanentFailureCount = 0
    controller.suppressedUntilMs = null
  } catch (error) {
    const message = errorMessage(error)
    if (
      message.includes(MANIFEST_NAME) ||
      message.includes('unmanifested and non-empty') ||
      message.includes('escapes auto-memory root')
    ) {
      controller.suppressedReason = message
      controller.suppressedUntilMs = null
    } else if (error instanceof MemoryServiceError && error.permanent) {
      controller.permanentFailureCount++
      if (controller.permanentFailureCount >= PERMANENT_FAILURE_LIMIT) {
        controller.suppressedReason = error.reason ?? message
        controller.suppressedUntilMs =
          Date.now() + PERMANENT_FAILURE_RETRY_MS
      }
    }
    logForDebugging(
      `multi-store-memory[${controller.store.mount}]: sync failed: ${message}`,
      { level: 'warn' },
    )
  }
}

function buildRuntimeState(): RuntimeState {
  const raw = process.env.CLAUDE_MEMORY_STORES?.trim() ?? ''
  const parsed = getMemoryStoresConfig()
  if (!parsed.active) return { raw, controllers: [] }
  if (parsed.error) return { raw, controllers: [], error: parsed.error }
  try {
    return {
      raw,
      controllers: parsed.stores.map(store => ({
        store,
        backend: backendFactory(store),
        mountDir: getMemoryStoreMountDir(store),
        remote: new Map(),
        basis: new Map(),
        pendingDeletes: new Map(),
        pulled: false,
        suppressedReason: null,
        suppressedUntilMs: null,
        permanentFailureCount: 0,
      })),
    }
  } catch (error) {
    return { raw, controllers: [], error: errorMessage(error) }
  }
}

function getRuntimeState(): RuntimeState {
  const raw = process.env.CLAUDE_MEMORY_STORES?.trim() ?? ''
  if (!runtimeState || runtimeState.raw !== raw) runtimeState = buildRuntimeState()
  return runtimeState
}

async function syncAll(allowDeletes: boolean): Promise<void> {
  const state = getRuntimeState()
  if (state.error) {
    logForDebugging(`multi-store-memory: ${state.error}`, { level: 'warn' })
    return
  }
  // 2.1.221 establishes shared state before the private store on startup.
  const teamControllers = state.controllers.filter(
    controller => controller.store.scope === 'team',
  )
  const userControllers = state.controllers.filter(
    controller => controller.store.scope === 'user',
  )
  await Promise.all(
    teamControllers.map(controller => syncController(controller, allowDeletes)),
  )
  await Promise.all(
    userControllers.map(controller => syncController(controller, allowDeletes)),
  )
  const skillDirs = state.controllers
    .filter(controller => controller.pulled && !controller.suppressedReason)
    .flatMap(controller =>
      (controller.store.skillsDirs ?? []).map(dir =>
        join(controller.mountDir, ...dir.split('/')),
      ),
    )
  if (skillDirs.length > 0) {
    await addSkillDirectories(skillDirs, {
      disallowSymlinks: true,
      maxSkillBytes: 128 * 1024,
    })
  }
  if (
    state.controllers.some(
      controller =>
        controller.store.mode === 'rw' && controller.pendingDeletes.size > 0,
    )
  ) {
    armDeleteRecheck()
  }
}

function scheduleWatchedSync(): void {
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
  watchDebounceTimer = setTimeout(() => {
    watchDebounceTimer = null
    void syncMultiStoreMemory()
  }, WATCH_DEBOUNCE_MS)
  watchDebounceTimer.unref()
}

function armDeleteRecheck(): void {
  if (deleteRecheckTimer) return
  deleteRecheckTimer = setTimeout(() => {
    deleteRecheckTimer = null
    void syncMultiStoreMemory()
  }, DELETE_RECHECK_MS)
  deleteRecheckTimer.unref()
}

function startFileWatcher(): void {
  if (fileWatcher) return
  const mounts = getRuntimeState().controllers
    .map(controller => controller.mountDir)
  if (mounts.length === 0) return
  fileWatcher = watch(mounts, {
    ignoreInitial: true,
    persistent: true,
    ignored: path =>
      path.endsWith(MANIFEST_NAME) || path.endsWith(BASIS_NAME),
  })
  fileWatcher.on('add', scheduleWatchedSync)
  fileWatcher.on('change', scheduleWatchedSync)
  fileWatcher.on('unlink', scheduleWatchedSync)
  fileWatcher.on('error', error =>
    logForDebugging(`multi-store-memory watcher: ${errorMessage(error)}`, {
      level: 'warn',
    }),
  )
}

export function syncMultiStoreMemory(allowDeletes = true): Promise<void> {
  if (!hasConfiguredMemoryStores()) return Promise.resolve()
  if (inFlightSync) return inFlightSync
  inFlightSync = syncAll(allowDeletes).finally(() => {
    inFlightSync = null
  })
  return inFlightSync
}

export async function ensureMultiStoreMemoryReady(
  deadlineMs = FIRST_PULL_DEADLINE_MS,
): Promise<void> {
  const sync = syncMultiStoreMemory()
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    sync,
    new Promise<void>(resolvePromise => {
      timer = setTimeout(resolvePromise, deadlineMs)
      timer.unref()
    }),
  ])
  if (timer) clearTimeout(timer)
}

export async function flushMultiStoreMemory(allowDeletes = true): Promise<void> {
  await syncMultiStoreMemory(allowDeletes)
}

export function startMultiStoreMemorySync(): void {
  if (!hasConfiguredMemoryStores()) return
  void syncMultiStoreMemory().finally(startFileWatcher)
  const periodicSyncMinutes = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_memory_store_resync_interval_minutes',
    DEFAULT_PERIODIC_SYNC_MINUTES,
  )
  const periodicSyncMs =
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MEMORY_PERIODIC_RESYNC) &&
    typeof periodicSyncMinutes === 'number' &&
    Number.isFinite(periodicSyncMinutes) &&
    periodicSyncMinutes > 0
      ? Math.max(periodicSyncMinutes, 1) * 60_000
      : 0
  if (!periodicTimer && periodicSyncMs > 0) {
    periodicTimer = setInterval(() => void syncMultiStoreMemory(), periodicSyncMs)
    periodicTimer.unref()
  }
  if (!cleanupRegistered) {
    cleanupRegistered = true
    unregisterCleanup = registerCleanup(async () => {
      if (periodicTimer) {
        clearInterval(periodicTimer)
        periodicTimer = null
      }
      if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
      watchDebounceTimer = null
      if (deleteRecheckTimer) clearTimeout(deleteRecheckTimer)
      deleteRecheckTimer = null
      await fileWatcher?.close().catch(() => {})
      fileWatcher = null
      // The official shutdown flush uploads edits but never confirms deletes.
      await flushMultiStoreMemory(false)
    })
  }
}

export function getMultiStoreControllers(): ReadonlyArray<{
  store: MemoryStoreConfig
  mountDir: string
  suppressedReason: string | null
}> {
  return getRuntimeState().controllers
}

export function getMultiStoreRuntimeError(): string | undefined {
  return getRuntimeState().error
}

export async function readMultiStorePromptIndexes(): Promise<
  Array<{ store: MemoryStoreConfig; mountDir: string; content: string }>
> {
  await ensureMultiStoreMemoryReady()
  const results: Array<{
    store: MemoryStoreConfig
    mountDir: string
    content: string
  }> = []
  for (const controller of getRuntimeState().controllers) {
    // XAu in 2.1.221 fetches only explicitly declared promptIndex entries.
    const promptIndex = controller.store.promptIndex
    if (promptIndex === undefined) continue
    if (controller.suppressedReason) continue
    const path = localPathFor(controller, promptIndex)
    try {
      const content = await readFile(path, 'utf8')
      results.push({
        store: controller.store,
        mountDir: controller.mountDir,
        // 2.1.221 fetches the complete prompt-index document here. Its Ren
        // prompt compositor applies the shared 200-line/25K splice and emits
        // the warning; truncating here would silently hide that warning.
        content,
      })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        logForDebugging(
          `multi-store-memory[${controller.store.mount}]: prompt index read failed: ${errorMessage(error)}`,
          { level: 'warn' },
        )
      }
      results.push({
        store: controller.store,
        mountDir: controller.mountDir,
        content: '',
      })
    }
  }
  return results
}

export function resetMultiStoreMemoryForTesting(): void {
  runtimeState = null
  inFlightSync = null
  if (periodicTimer) clearInterval(periodicTimer)
  periodicTimer = null
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
  watchDebounceTimer = null
  if (deleteRecheckTimer) clearTimeout(deleteRecheckTimer)
  deleteRecheckTimer = null
  void fileWatcher?.close().catch(() => {})
  fileWatcher = null
  unregisterCleanup?.()
  unregisterCleanup = null
  cleanupRegistered = false
  backendFactory = defaultBackendFactory
}

export function setMultiStoreMemoryBackendFactoryForTesting(
  factory: (store: MemoryStoreConfig) => MultiStoreMemoryBackend,
): void {
  runtimeState = null
  backendFactory = factory
}
