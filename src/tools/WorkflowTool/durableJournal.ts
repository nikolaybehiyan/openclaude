import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { types } from 'node:util'
import { indexWorkflowJournal, type WorkflowJournalIndex, type WorkflowJournalRecord } from './journal.js'
import { workflowScriptFingerprint, type ResolvedWorkflow } from './registry.js'
import { MAX_WORKFLOW_SCRIPT_LENGTH, parseWorkflowScript } from './scriptParser.js'

const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024
const ZERO_HASH = '0'.repeat(64)
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export type WorkflowRunOwner = Readonly<{sessionId: string; agentId: string}>
export type WorkflowReplayReceipt = Readonly<{sourceRunId?: string; reused: boolean; reason: 'new-run' | 'validated-source' | 'arguments-changed'; records: number; discardedTailBytes: number}>
export type WorkflowRunLease = {
  runId: string
  approved: ResolvedWorkflow
  args: unknown
  scriptPath: string
  replay: WorkflowReplayReceipt
  journal: {load(): Promise<WorkflowJournalIndex>; append(record: WorkflowJournalRecord): Promise<void>}
  close(): Promise<void>
}
type StoredManifest = {
  version: 1
  runId: string
  owner: WorkflowRunOwner
  scriptFingerprint: string
  source?: ResolvedWorkflow['source']
  resolvedScriptPath?: string
  args: {present: boolean; value?: unknown}
  argsFingerprint: string
  replay: WorkflowReplayReceipt
  seedBytes: number
  seedFingerprint: string
}
type JournalRow = {sequence: number; previous: string; record: WorkflowJournalRecord; checksum: string}

// Host-owned JSON only. Never call a VM getter/toJSON while persisting data.
// The runner must cross its membrane before invoking append/create.
function snapshotJSON(value: unknown, depth = 0, seen = new Set<object>()): any {
  if (depth > 100) throw Error('Workflow JSON is too deeply nested')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || types.isProxy(value)) throw Error('Workflow persistence requires plain JSON values')
  if (seen.has(value)) throw Error('Workflow JSON is circular')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) throw Error('Workflow persistence requires plain JSON values')
  seen.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result: any = Array.isArray(value) ? [] : Object.create(null)
    if (Array.isArray(value) && value.length > 100_000) throw Error('Workflow JSON has too many values')
    const keys = Array.isArray(value) ? Array.from({length: value.length}, (_, i) => String(i)) : Object.keys(descriptors).filter(key => descriptors[key]!.enumerable).sort()
    if (keys.length > 100_000) throw Error('Workflow JSON has too many values')
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor)) throw Error('Workflow JSON must not contain getters or sparse arrays')
      result[key] = snapshotJSON(descriptor.value, depth + 1, seen)
    }
    return Object.freeze(result)
  } finally { seen.delete(value) }
}
function json(value: unknown): string {
  const text = JSON.stringify(snapshotJSON(value))
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw Error('Workflow JSON exceeds persistence limit')
  return text
}
function validID(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw Error('Invalid workflow run ID')
}
function ownerSnapshot(owner: WorkflowRunOwner): WorkflowRunOwner {
  if (typeof owner.sessionId !== 'string' || typeof owner.agentId !== 'string' || !owner.sessionId || !owner.agentId || owner.sessionId.length > 256 || owner.agentId.length > 256) throw Error('Invalid workflow run owner')
  return Object.freeze({sessionId: owner.sessionId, agentId: owner.agentId})
}
function approvedSnapshot(approved: ResolvedWorkflow): ResolvedWorkflow {
  if (Buffer.byteLength(approved.script) > MAX_WORKFLOW_SCRIPT_LENGTH || workflowScriptFingerprint(approved.script) !== approved.fingerprint) throw Error('Approved workflow fingerprint mismatch')
  const parsed = parseWorkflowScript(approved.script)
  if ('error' in parsed || parsed.scriptBody !== approved.scriptBody) throw Error('Approved workflow body mismatch')
  if (parsed.meta.phases) { parsed.meta.phases.forEach(Object.freeze); Object.freeze(parsed.meta.phases) }
  return Object.freeze({...approved, meta: Object.freeze(parsed.meta)})
}
function privateStat(stat: Stats, directory: boolean) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1)) throw Error('Workflow storage must not use symlinks, hardlinks or special files')
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) throw Error('Workflow storage must be private to its owner')
}
async function checkedDirectory(directory: string) {
  const stat = await lstat(directory)
  privateStat(stat, true)
  return stat
}
async function readPrivate(file: string, limit: number): Promise<Buffer> {
  const before = await lstat(file)
  privateStat(before, false)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    privateStat(stat, false)
    if (before.ino !== stat.ino || before.dev !== stat.dev || stat.size > limit) throw Error('Workflow storage changed or exceeds limit')
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let length = 0
    while (length < bytes.length) {
      const next = await handle.read(bytes, length, bytes.length - length, null)
      if (!next.bytesRead) break
      length += next.bytesRead
    }
    if (length > limit || length !== stat.size) throw Error('Workflow storage changed or exceeds limit')
    return bytes.subarray(0, length)
  } finally { await handle.close() }
}
async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return
  const handle = await open(directory, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}
async function writeNew(file: string, bytes: string | Buffer) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

// All lease creation/removal/recovery shares this short atomic transition.
// It is deliberately not a TTL lock. A process dying inside this filesystem
// transaction also requires explicit operator reconciliation.
function transition<T>(directory: string, action: () => T): T {
  const guard = path.join(directory, '.lease-transition')
  try { mkdirSync(guard, {mode: 0o700}) }
  catch { throw Error('Workflow lease transition is busy or requires explicit reconciliation') }
  try { return action() } finally { rmdirSync(guard) }
}
function lockIdentity(lock: string) {
  const stat = lstatSync(lock)
  privateStat(stat, true)
  const ownerPath = path.join(lock, 'owner.json')
  const before = lstatSync(ownerPath)
  privateStat(before, false)
  const fd = openSync(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let owner
  try {
    const current = fstatSync(fd)
    privateStat(current, false)
    if (current.size > 4096 || before.dev !== current.dev || before.ino !== current.ino) throw Error('Invalid workflow lease owner file')
    owner = JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
  if (typeof owner.token !== 'string') throw Error('Invalid workflow lease owner')
  return {stat, token: owner.token as string}
}

// Persistent fail-closed lease: no PID signalling, TTL or automatic stale-lock
// removal. Source and destination leases cover the WHOLE run, not only reading.
async function acquire(directory: string) {
  await checkedDirectory(directory)
  const lock = path.join(directory, '.lease')
  const token = randomUUID()
  const identity = transition(directory, () => {
    try { mkdirSync(lock, {mode: 0o700}) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('Workflow run is active or requires explicit abandoned-lease reconciliation')
      throw error
    }
    writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({token, pid: process.pid}), {mode: 0o600, flag: 'wx'})
    return lstatSync(lock)
  })
  await syncDirectory(lock)
  let released = false
  function assertHeldSync() {
    if (released) throw Error('Workflow lease is closed')
    const current = lockIdentity(lock)
    if (current.stat.dev !== identity.dev || current.stat.ino !== identity.ino || current.token !== token) throw Error('Workflow lease ownership changed')
  }
  return {
    token,
    async assertHeld() { assertHeldSync() },
    async release() {
      if (released) return
      transition(directory, () => {
        assertHeldSync()
        unlinkSync(path.join(lock, 'owner.json'))
        rmdirSync(lock)
        released = true
      })
      await syncDirectory(directory)
    },
  }
}

/** Host lifecycle API only. Never expose this callback/decision to a workflow
 * or turn it into a force/recover boolean on WorkflowTool. The trusted runtime
 * must establish that this exact lease's execution has stopped. */
export async function recoverStoppedRunLease(options: {
  rootDirectory: string
  runId: string
  owner: WorkflowRunOwner
  expectedToken: string
  proveStopped: (identity: Readonly<{rootDirectory: string; runId: string; owner: WorkflowRunOwner; token: string}>) => Promise<boolean>
}): Promise<{quarantinedLock: string}> {
  validID(options.runId)
  const owner = ownerSnapshot(options.owner)
  await checkedDirectory(options.rootDirectory)
  const root = await realpath(options.rootDirectory)
  const directory = path.join(root, options.runId)
  await checkedDirectory(directory)
  // Ownership/integrity are prerequisites even for requesting lifecycle proof.
  await readStored(directory, options.runId, owner)
  const lock = path.join(directory, '.lease')
  const initial = lockIdentity(lock)
  if (initial.token !== options.expectedToken) throw Error('Workflow recovery token mismatch')
  if (!await options.proveStopped(Object.freeze({rootDirectory: root, runId: options.runId, owner, token: initial.token}))) throw Error('Trusted lifecycle did not confirm that workflow execution stopped')
  // Recheck after the asynchronous proof, under the same transition used by
  // normal acquire/release. A different/new lease can never be quarantined.
  const quarantinedLock = transition(directory, () => {
    const current = lockIdentity(lock)
    if (current.stat.ino !== initial.stat.ino || current.stat.dev !== initial.stat.dev || current.token !== options.expectedToken) throw Error('Workflow lease changed during recovery')
    const target = path.join(directory, 'quarantined-lease-' + randomUUID())
    renameSync(lock, target)
    return target
  })
  await syncDirectory(directory)
  return {quarantinedLock}
}
function recordSnapshot(record: WorkflowJournalRecord): WorkflowJournalRecord {
  const value = snapshotJSON(record)
  if (!value || (value.type !== 'started' && value.type !== 'result') || typeof value.key !== 'string' || !/^v2:[a-f0-9]{64}$/.test(value.key) || typeof value.agentId !== 'string' || value.agentId.length > 256) throw Error('Invalid workflow journal record')
  if (value.type === 'result' && !Object.hasOwn(value, 'result')) throw Error('Workflow result record lacks result')
  const keys = Object.keys(value).sort().join(',')
  if (keys !== (value.type === 'started' ? 'agentId,key,type' : 'agentId,key,result,type')) throw Error('Unknown workflow journal fields')
  return value
}
function journalState(bytes: Buffer) {
  const end = bytes.lastIndexOf(10) + 1
  let previous = ZERO_HASH
  const records: WorkflowJournalRecord[] = []
  const complete = bytes.subarray(0, end)
  for (const line of complete.toString('utf8').split('\n').slice(0, -1)) {
    let row: JournalRow
    try { row = JSON.parse(line) }
    catch { throw Error('Corrupt committed workflow journal record') }
    const record = recordSnapshot(row.record)
    if (row.sequence !== records.length || row.previous !== previous || row.checksum !== digest(json({sequence: row.sequence, previous: row.previous, record}))) throw Error('Workflow journal integrity mismatch')
    previous = row.checksum
    records.push(record)
  }
  return {records, previous, complete, discardedTailBytes: bytes.length - end}
}
async function readStored(directory: string, runId: string, owner: WorkflowRunOwner) {
  const manifest = JSON.parse((await readPrivate(path.join(directory, 'manifest.json'), MAX_JSON_BYTES)).toString('utf8')) as StoredManifest
  if (manifest.version !== 1 || manifest.runId !== runId || manifest.owner?.sessionId !== owner.sessionId || manifest.owner?.agentId !== owner.agentId) throw Error('Workflow resume owner or run mismatch')
  const script = await readPrivate(path.join(directory, 'approved.js'), MAX_WORKFLOW_SCRIPT_LENGTH)
  if (digest(script) !== manifest.scriptFingerprint) throw Error('Stored approved workflow fingerprint mismatch')
  const parsed = parseWorkflowScript(script.toString('utf8'))
  if ('error' in parsed) throw Error('Invalid stored approved workflow')
  if (digest(json(manifest.args)) !== manifest.argsFingerprint) throw Error('Workflow arguments fingerprint mismatch')
  const bytes = await readPrivate(path.join(directory, 'journal.jsonl'), MAX_JOURNAL_BYTES)
  if (!Number.isSafeInteger(manifest.seedBytes) || manifest.seedBytes < 0 || manifest.seedBytes > bytes.length || digest(bytes.subarray(0, manifest.seedBytes)) !== manifest.seedFingerprint) throw Error('Workflow replay seed fingerprint mismatch')
  return {manifest, ...journalState(bytes)}
}

export async function createWorkflowRun(options: {
  /** Trusted private session-owned directory, never a script-supplied path. */
  rootDirectory: string
  runId: string
  owner: WorkflowRunOwner
  approved: ResolvedWorkflow
  args?: unknown
  resumeFromRunId?: string
}): Promise<WorkflowRunLease> {
  validID(options.runId)
  if (options.resumeFromRunId !== undefined) {
    validID(options.resumeFromRunId)
    if (options.runId === options.resumeFromRunId) throw Error('Resume requires a unique new workflow run ID')
  }
  const owner = ownerSnapshot(options.owner)
  const approved = approvedSnapshot(options.approved)
  const args = options.args === undefined ? undefined : snapshotJSON(options.args)
  const argsRecord = args === undefined ? {present: false} : {present: true, value: args}
  const argsFingerprint = digest(json(argsRecord))
  await mkdir(options.rootDirectory, {recursive: true, mode: 0o700})
  await checkedDirectory(options.rootDirectory)
  const root = await realpath(options.rootDirectory)
  const directory = path.join(root, options.runId)
  const locks: Awaited<ReturnType<typeof acquire>>[] = []
  let handle: FileHandle | undefined
  try {
    let seed = Buffer.alloc(0)
    let replay: WorkflowReplayReceipt = {reused: false, reason: 'new-run', records: 0, discardedTailBytes: 0}
    if (options.resumeFromRunId) {
      const source = path.join(root, options.resumeFromRunId)
      locks.push(await acquire(source))
      const stored = await readStored(source, options.resumeFromRunId, owner)
      const sameArgs = stored.manifest.argsFingerprint === argsFingerprint
      if (sameArgs) seed = Buffer.from(stored.complete)
      replay = {sourceRunId: options.resumeFromRunId, reused: sameArgs, reason: sameArgs ? 'validated-source' : 'arguments-changed',
        records: sameArgs ? stored.records.length : 0, discardedTailBytes: stored.discardedTailBytes}
    }
    // EEXIST is never interpreted as permission to overwrite an older run.
    await mkdir(directory, {mode: 0o700})
    locks.push(await acquire(directory))
    const scriptPath = path.join(directory, 'approved.js')
    await writeNew(scriptPath, approved.script)
    const journalPath = path.join(directory, 'journal.jsonl')
    await writeNew(journalPath, seed)
    const manifest: StoredManifest = {version: 1, runId: options.runId, owner, scriptFingerprint: approved.fingerprint,
      ...(approved.source ? {source: approved.source} : {}), ...(approved.resolvedScriptPath ? {resolvedScriptPath: approved.resolvedScriptPath} : {}),
      args: argsRecord, argsFingerprint, replay, seedBytes: seed.length, seedFingerprint: digest(seed)}
    await writeNew(path.join(directory, 'manifest.json'), json(manifest))
    await syncDirectory(directory)
    await syncDirectory(root)
    handle = await open(journalPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
    const identity = await handle.stat()
    privateStat(identity, false)
    const state = journalState(seed)
    let size = seed.length, closed = false, failure: unknown
    let queue: Promise<void> = Promise.resolve()
    let closing: Promise<void> | undefined
    async function assertHeld() {
      if (closed) throw Error('Workflow lease is closed')
      if (failure) throw failure
      for (const lock of locks) await lock.assertHeld()
      const current = await lstat(journalPath)
      privateStat(current, false)
      if (current.dev !== identity.dev || current.ino !== identity.ino || current.size !== size) throw Error('Workflow journal changed while leased')
    }
    return {
      runId: options.runId, approved, args, scriptPath, replay: Object.freeze(replay),
      journal: {
        async load() { await queue; await assertHeld(); return indexWorkflowJournal(state.records) },
        append(record) {
          // Snapshot synchronously so callers cannot mutate queued records.
          let snapshot: WorkflowJournalRecord
          try { snapshot = recordSnapshot(record) } catch (error) { return Promise.reject(error) }
          const operation = queue.then(async () => {
            await assertHeld()
            const body = {sequence: state.records.length, previous: state.previous, record: snapshot}
            const checksum = digest(json(body))
            const line = json({...body, checksum}) + '\n'
            if (size + Buffer.byteLength(line) > MAX_JOURNAL_BYTES) throw Error('Workflow journal exceeds persistence limit')
            await handle!.writeFile(line)
            await handle!.sync()
            size += Buffer.byteLength(line)
            state.previous = checksum
            state.records.push(snapshot)
          })
          queue = operation.catch(error => { failure = error })
          return operation
        },
      },
      close() {
        return closing ??= (async () => {
          await queue
          closed = true
          try { await handle!.close() }
          finally {
            const releases = await Promise.allSettled([...locks].reverse().map(lock => lock.release()))
            const rejected = releases.find(result => result.status === 'rejected')
            if (rejected?.status === 'rejected') throw rejected.reason
          }
          if (failure) throw failure
        })()
      },
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    for (const lock of [...locks].reverse()) await lock.release().catch(() => {})
    throw error
  }
}
