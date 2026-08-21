import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { unzipFile } from '../dxt/zip.js'

const DEFAULT_SYNC_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_INITIAL_WAIT_MS = 5 * 1000
const DEFAULT_INSTALL_TIMEOUT_MS = 30 * 1000
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_SKILLS = 512
const DOWNLOAD_CONCURRENCY = 15
const MANIFEST_FILENAME = 'manifest.json'
const STAGING_DIRECTORY = '.staging'

export type RemoteSkillReference = {
  id: string
  name: string
  description?: string
  version: string
  directory: string
}

type RemoteSkillManifest = {
  skills: RemoteSkillReference[]
  plugins?: unknown[]
}

type InstalledSkill = {
  id: string
  version: string
  directory: string
}

type InstalledManifest = {
  version: 1
  skills: InstalledSkill[]
}

export type RemoteSkillSyncOptions = {
  configDir: string
  apiBaseURL: string
  sessionID: string
  token: string
  fetchImpl?: typeof fetch
  installTimeoutMs?: number
}

type StagedSkill = {
  reference: RemoteSkillReference
  path: string
}

let syncTimer: ReturnType<typeof setInterval> | undefined
let syncInFlight: Promise<void> | undefined

export async function startRemoteSkillSync(): Promise<void> {
  if (!remoteSkillSyncEnabled() || syncTimer || syncInFlight) return

  const options = remoteSkillSyncOptionsFromEnvironment()
  if (!options) {
    logForDebugging(
      '[remote-skills] required session control environment is unavailable',
      { level: 'warn' },
    )
    return
  }

  const run = (): Promise<void> => {
    if (!syncInFlight) {
      syncInFlight = syncRemoteSkillsOnce({
        ...options,
        token: process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN ?? options.token,
      })
        .catch(error => {
          logForDebugging(
            `[remote-skills] sync failed: ${error instanceof Error ? error.message : String(error)}`,
            { level: 'warn' },
          )
        })
        .finally(() => {
          syncInFlight = undefined
        })
    }
    return syncInFlight
  }

  const initial = run()
  const initialWaitMs = positiveIntegerEnvironment(
    'CLAUDE_CODE_SYNC_SKILLS_WAIT_TIMEOUT_MS',
    DEFAULT_INITIAL_WAIT_MS,
  )
  await Promise.race([
    initial,
    new Promise<void>(resolve => setTimeout(resolve, initialWaitMs)),
  ])

  syncTimer = setInterval(() => void run(), DEFAULT_SYNC_INTERVAL_MS)
  syncTimer.unref?.()
  registerCleanup(async () => {
    if (syncTimer) clearInterval(syncTimer)
    syncTimer = undefined
    await syncInFlight
  })
}

export async function syncRemoteSkillsOnce(
  options: RemoteSkillSyncOptions,
): Promise<void> {
  validateSyncOptions(options)
  const fetchImpl = options.fetchImpl ?? fetch
  const skillsRoot = join(options.configDir, 'skills')
  const stagingRoot = join(skillsRoot, STAGING_DIRECTORY)
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  await chmod(skillsRoot, 0o700).catch(() => {})
  await chmod(stagingRoot, 0o700).catch(() => {})

  const desired = await fetchRemoteSkillManifest(options, fetchImpl)
  const installed = await readInstalledManifest(skillsRoot)
  validateDesiredManifest(desired)

  const installedByID = new Map(installed.skills.map(skill => [skill.id, skill]))
  const installedDirectories = new Set(
    installed.skills.map(skill => skill.directory),
  )
  const changed = desired.skills.filter(skill => {
    const current = installedByID.get(skill.id)
    return (
      !current ||
      current.version !== skill.version ||
      current.directory !== skill.directory
    )
  })

  for (const skill of desired.skills) {
    const target = join(skillsRoot, skill.directory)
    const current = installedByID.get(skill.id)
    if (current?.version === skill.version && current.directory === skill.directory) {
      await requireRegularSkillDirectory(target)
      continue
    }
    if (
      await pathExists(target)
    ) {
      if (!installedDirectories.has(skill.directory)) {
        throw new Error(
          `refusing to replace unmanaged skill directory ${skill.directory}`,
        )
      }
      await requireRegularDirectory(target)
    }
  }

  const transactionRoot = join(stagingRoot, `sync-${randomUUID()}`)
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 })
  const staged = await mapWithConcurrency(
    changed,
    DOWNLOAD_CONCURRENCY,
    async reference => {
      const archive = await downloadRemoteSkill(
        options,
        fetchImpl,
        reference,
      )
      const path = join(transactionRoot, reference.directory)
      await extractSkillArchive(archive, path)
      return { reference, path }
    },
  ).catch(async error => {
    await rm(transactionRoot, { recursive: true, force: true })
    throw error
  })

  const backups = new Map<string, string>()
  const installedTargets: string[] = []
  try {
    for (const item of staged) {
      const target = join(skillsRoot, item.reference.directory)
      if (await pathExists(target)) {
        const backup = join(
          transactionRoot,
          `.backup-${item.reference.directory}-${randomUUID()}`,
        )
        await rename(target, backup)
        backups.set(target, backup)
      }
      await rename(item.path, target)
      installedTargets.push(target)
    }

    const nextManifest: InstalledManifest = {
      version: 1,
      skills: desired.skills.map(skill => ({
        id: skill.id,
        version: skill.version,
        directory: skill.directory,
      })),
    }
    await writeInstalledManifest(skillsRoot, nextManifest)

    const desiredDirectories = new Set(
      nextManifest.skills.map(skill => skill.directory),
    )
    for (const previous of installed.skills) {
      if (!desiredDirectories.has(previous.directory)) {
        await removeManagedSkillDirectory(skillsRoot, previous.directory)
      }
    }
    for (const backup of backups.values()) {
      await rm(backup, { recursive: true, force: true })
    }
    logForDebugging(
      `[remote-skills] synchronized ${nextManifest.skills.length} account skills`,
    )
  } catch (error) {
    for (const target of installedTargets.reverse()) {
      await rm(target, { recursive: true, force: true }).catch(() => {})
      const backup = backups.get(target)
      if (backup) await rename(backup, target).catch(() => {})
    }
    throw error
  } finally {
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export function remoteSkillSyncEnabled(): boolean {
  // The runtime owner sets this only for ordinary hosted Remote Code
  // sessions.  Do not couple skill synchronization to CLAUDE_CODE_REMOTE:
  // that flag owns the optional upstream-proxy relay and is absent when a
  // Remote session does not need that relay.
  return isEnvTruthy(process.env.CLAUDE_CODE_SYNC_SKILLS)
}

function remoteSkillSyncOptionsFromEnvironment():
  | RemoteSkillSyncOptions
  | undefined {
  const apiBaseURL = process.env.CLAUDE_CODE_API_BASE_URL?.trim()
  const sessionID = process.env.CLAUDE_CODE_SESSION_ID?.trim()
  const token = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN?.trim()
  if (!apiBaseURL || !sessionID || !token) return undefined
  return {
    configDir: getClaudeConfigHomeDir(),
    apiBaseURL,
    sessionID,
    token,
    installTimeoutMs: positiveIntegerEnvironment(
      'CLAUDE_CODE_SYNC_SKILLS_INSTALL_TIMEOUT_MS',
      DEFAULT_INSTALL_TIMEOUT_MS,
    ),
  }
}

function validateSyncOptions(options: RemoteSkillSyncOptions): void {
  const parsed = new URL(options.apiBaseURL)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Remote skill API base URL must be an absolute HTTP(S) URL')
  }
  if (!options.sessionID.trim() || /[\x00/\\]/.test(options.sessionID)) {
    throw new Error('Remote skill session ID is invalid')
  }
  if (!options.token.trim() || /[\x00\r\n]/.test(options.token)) {
    throw new Error('Remote skill session token is invalid')
  }
}

async function fetchRemoteSkillManifest(
  options: RemoteSkillSyncOptions,
  fetchImpl: typeof fetch,
): Promise<RemoteSkillManifest> {
  const url = workerURL(options, 'skill-manifest')
  const response = await boundedFetch(options, fetchImpl, url)
  if (!response.ok) {
    throw new Error(`manifest request failed with HTTP ${response.status}`)
  }
  const raw = Buffer.from(await response.arrayBuffer())
  if (raw.length > MAX_MANIFEST_BYTES) {
    throw new Error('Remote skill manifest exceeds its size limit')
  }
  const parsed = JSON.parse(raw.toString('utf8')) as RemoteSkillManifest
  if (!parsed || !Array.isArray(parsed.skills)) {
    throw new Error('Remote skill manifest is invalid')
  }
  return { skills: parsed.skills, plugins: [] }
}

async function downloadRemoteSkill(
  options: RemoteSkillSyncOptions,
  fetchImpl: typeof fetch,
  skill: RemoteSkillReference,
): Promise<Buffer> {
  const response = await boundedFetch(
    options,
    fetchImpl,
    workerURL(options, `skills/${encodeURIComponent(skill.id)}/download`),
  )
  if (!response.ok) {
    throw new Error(
      `skill ${skill.id} download failed with HTTP ${response.status}`,
    )
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`skill ${skill.id} archive exceeds its size limit`)
  }
  const archive = Buffer.from(await response.arrayBuffer())
  if (archive.length > MAX_ARCHIVE_BYTES || !isZipArchive(archive)) {
    throw new Error(`skill ${skill.id} archive is invalid`)
  }
  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest !== skill.version.toLowerCase()) {
    throw new Error(`skill ${skill.id} archive digest does not match manifest`)
  }
  return archive
}

async function boundedFetch(
  options: RemoteSkillSyncOptions,
  fetchImpl: typeof fetch,
  url: string,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
  )
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN ?? options.token}`,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

function workerURL(options: RemoteSkillSyncOptions, suffix: string): string {
  return `${options.apiBaseURL.replace(/\/$/, '')}/v1/code/sessions/${encodeURIComponent(options.sessionID)}/worker/${suffix}`
}

function validateDesiredManifest(manifest: RemoteSkillManifest): void {
  if (manifest.skills.length > MAX_SKILLS) {
    throw new Error('Remote skill manifest contains too many skills')
  }
  const ids = new Set<string>()
  const directories = new Set<string>()
  for (const skill of manifest.skills) {
    if (
      !skill ||
      typeof skill.id !== 'string' ||
      !skill.id ||
      /[\x00/\\\s]/.test(skill.id) ||
      skill.id.length > 256 ||
      typeof skill.name !== 'string' ||
      !skill.name.trim() ||
      typeof skill.version !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(skill.version) ||
      !safeDirectoryName(skill.directory)
    ) {
      throw new Error('Remote skill manifest contains an invalid skill')
    }
    if (ids.has(skill.id) || directories.has(skill.directory)) {
      throw new Error('Remote skill manifest contains duplicate identity')
    }
    ids.add(skill.id)
    directories.add(skill.directory)
  }
}

async function extractSkillArchive(
  archive: Buffer,
  destination: string,
): Promise<void> {
  const entries = await unzipFile(archive)
  const files = Object.keys(entries).filter(path => !path.endsWith('/'))
  const wrapper = skillArchiveWrapper(files)
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const archivePath of files) {
    const relativePath = wrapper
      ? archivePath.slice(wrapper.length + 1)
      : archivePath
    if (!relativePath) continue
    const output = join(destination, relativePath)
    if (!pathContained(destination, output)) {
      throw new Error('Remote skill archive escaped its destination')
    }
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await writeFile(output, entries[archivePath], { mode: 0o600 })
  }
  await requireRegularSkillDirectory(destination)
}

function skillArchiveWrapper(files: string[]): string | undefined {
  if (files.includes('SKILL.md')) return undefined
  const roots = new Set(files.map(path => path.split('/')[0]).filter(Boolean))
  if (roots.size !== 1) {
    throw new Error('Remote skill archive must contain one skill root')
  }
  const root = [...roots][0]!
  if (!files.includes(`${root}/SKILL.md`)) {
    throw new Error('Remote skill archive does not contain SKILL.md')
  }
  if (files.some(path => path !== root && !path.startsWith(`${root}/`))) {
    throw new Error('Remote skill archive contains files outside its skill root')
  }
  return root
}

async function readInstalledManifest(
  skillsRoot: string,
): Promise<InstalledManifest> {
  try {
    const raw = await readFile(join(skillsRoot, MANIFEST_FILENAME), 'utf8')
    const parsed = JSON.parse(raw) as InstalledManifest
    if (parsed?.version !== 1 || !Array.isArray(parsed.skills)) {
      throw new Error('invalid manifest')
    }
    const skills = parsed.skills.filter(
      skill =>
        skill &&
        typeof skill.id === 'string' &&
        typeof skill.version === 'string' &&
        safeDirectoryName(skill.directory),
    )
    return { version: 1, skills }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, skills: [] }
    }
    throw new Error('Remote skill installation manifest is invalid')
  }
}

async function writeInstalledManifest(
  skillsRoot: string,
  manifest: InstalledManifest,
): Promise<void> {
  const temporary = join(
    skillsRoot,
    STAGING_DIRECTORY,
    `manifest-${randomUUID()}.json`,
  )
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, join(skillsRoot, MANIFEST_FILENAME))
}

async function removeManagedSkillDirectory(
  skillsRoot: string,
  directory: string,
): Promise<void> {
  if (!safeDirectoryName(directory)) return
  const target = join(skillsRoot, directory)
  if (!pathContained(skillsRoot, target)) return
  await requireRegularDirectory(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  await rm(target, { recursive: true, force: true })
}

async function requireRegularSkillDirectory(path: string): Promise<void> {
  await requireRegularDirectory(path)
  const skillFile = await lstat(join(path, 'SKILL.md'))
  if (!skillFile.isFile() || skillFile.isSymbolicLink()) {
    throw new Error(`Remote skill ${basename(path)} has invalid SKILL.md`)
  }
}

async function requireRegularDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${basename(path)} is not a regular directory`)
  }
}

function safeDirectoryName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value !== '.' &&
    value !== '..' &&
    value !== MANIFEST_FILENAME &&
    value !== STAGING_DIRECTORY &&
    !/[\x00/\\]/.test(value)
  )
}

function pathContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function isZipArchive(raw: Buffer): boolean {
  return (
    raw.length >= 4 &&
    raw[0] === 0x50 &&
    raw[1] === 0x4b &&
    [3, 5, 7].includes(raw[2]!) &&
    [4, 6, 8].includes(raw[3]!)
  )
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = next++
        if (index >= values.length) return
        result[index] = await operation(values[index]!)
      }
    },
  )
  await Promise.all(workers)
  return result
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
