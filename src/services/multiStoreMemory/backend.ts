import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { getSessionIngressAuthHeaders } from '../../utils/sessionIngressAuth.js'
import type { MemoryStoreConfig } from './config.js'

export type RemoteMemoryEntry = {
  id: string
  path: string
  sha256: string
  sizeBytes?: number
}

export type RemoteMemoryDocument = RemoteMemoryEntry & {
  content: string
  updatedAt: string
}

export class MemoryConflictError extends Error {
  constructor(
    readonly path: string,
    readonly existingId?: string,
  ) {
    super(`memory conflict on ${path}`)
    this.name = 'MemoryConflictError'
  }
}

export class MemoryNotFoundError extends Error {
  constructor(readonly memoryId: string) {
    super(`memory not found: ${memoryId}`)
    this.name = 'MemoryNotFoundError'
  }
}

export class MemoryServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly permanent = false,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'MemoryServiceError'
  }
}

const MEMORY_ID_RE = /^mem_[A-Za-z0-9]+$/
const REQUEST_TIMEOUT_MS = 30_000
const PAGE_LIMIT = 100
const MAX_LIST_ENTRIES = 200_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeRemotePath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new MemoryServiceError('memory response path is not a string', 500, true)
  }
  const stripped = value.replace(/^\/+/, '')
  const segments = stripped.split('/')
  if (
    !stripped ||
    value.includes('\\') ||
    value.normalize('NFC') !== value ||
    segments.some(
      segment =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[\u0000-\u001f\u007f]/.test(segment),
    )
  ) {
    throw new MemoryServiceError(`unsafe memory path ${value}`, 500, true)
  }
  return '/' + stripped
}

function responseMessage(data: unknown): string | undefined {
  const record = asRecord(data)
  if (!record) return undefined
  if (typeof record.message === 'string') return record.message
  const error = asRecord(record.error)
  return error && typeof error.message === 'string' ? error.message : undefined
}

function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 409 && status !== 429
}

const INVALID_REQUEST_REASONS = new Map<string, string>([
  ['memory store has reached its memory limit', 'store_full'],
  ['memory store has reached its size limit', 'store_full'],
  ['content must be at most 102400 bytes', 'content_too_large'],
  [
    'memory content appears to contain a credential or API key; remove it before writing. If the credential is real, rotate it.',
    'content_secret',
  ],
  ['path must be at most 1024 bytes', 'invalid_path'],
  ['path must be at most 20 segments deep', 'invalid_path'],
  ['path must not contain . or .. segments', 'invalid_path'],
  ['path must not contain control or format characters', 'invalid_path'],
  ['path must be NFC-normalized', 'invalid_path'],
])

function responseError(data: unknown): {
  type?: string
  message?: string
} {
  const body = asRecord(data)
  const error = asRecord(body?.error)
  return {
    ...(typeof error?.type === 'string' && { type: error.type }),
    ...(typeof error?.message === 'string'
      ? { message: error.message }
      : typeof body?.message === 'string'
        ? { message: body.message }
        : {}),
  }
}

function permanentReason(status: number, data: unknown): string | undefined {
  if (!isPermanentStatus(status)) return undefined
  const error = responseError(data)
  if (
    status === 400 &&
    error.type === 'invalid_request_error' &&
    error.message !== undefined
  ) {
    const mapped = INVALID_REQUEST_REASONS.get(error.message)
    if (mapped) return mapped
    if (error.message.startsWith('cannot modify archived resource')) {
      return 'store_archived'
    }
  }
  return `http_${status}`
}

export class MemoryServiceBackend {
  readonly mode: MemoryStoreConfig['mode']
  readonly partitionId: string
  readonly label: string
  private readonly memoriesUrl: string
  private readonly exportUrl: string
  private readonly usesSessionControlAPI: boolean

  constructor(readonly store: MemoryStoreConfig) {
    this.mode = store.mode
    this.partitionId = store.path.replace(/\/+$/, '')
    this.label = store.mount
    // Hosted Code has a separate, supervisor-owned control origin. Memory
    // belongs to that owner, just like session references, not the public
    // OAuth/UI origin (which may not be reachable from a worker sandbox).
    // With no hosted origin, retain the native OAuth transport unchanged.
    const controlBase = process.env.CLAUDE_CODE_API_BASE_URL?.trim()
    this.usesSessionControlAPI = Boolean(controlBase)
    const base = (controlBase || getOauthConfig().BASE_API_URL).replace(/\/+$/, '')
    const baseUrl = new URL(base)
    if (
      !['http:', 'https:'].includes(baseUrl.protocol) ||
      baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
    ) {
      throw new MemoryServiceError('invalid memory API origin', undefined, true)
    }
    const partitionUrl = new URL(this.partitionId, base)
    if (partitionUrl.origin !== baseUrl.origin) {
      throw new MemoryServiceError(
        `memory store ${store.mount} overrides the configured API host`,
        undefined,
        true,
      )
    }
    this.memoriesUrl = partitionUrl.toString().replace(/\/+$/, '') + '/memories'
    this.exportUrl = this.memoriesUrl + '/export'
  }

  private authHeaders(): Record<string, string> {
    const sessionHeaders = getSessionIngressAuthHeaders()
    if (Object.keys(sessionHeaders).length > 0) return sessionHeaders
    if (this.usesSessionControlAPI) {
      // Never send a personal OAuth credential to a hosted worker endpoint.
      throw new MemoryServiceError('hosted memory requires session ingress authentication')
    }
    const oauth = getClaudeAIOAuthTokens()
    return oauth?.accessToken
      ? { Authorization: `Bearer ${oauth.accessToken}` }
      : {}
  }

  private async request<T>(
    config: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    try {
      return await axios.request<T>({
        ...config,
        headers: {
          Accept: 'application/json',
          ...this.authHeaders(),
          ...config.headers,
        },
        timeout: REQUEST_TIMEOUT_MS,
        ...(this.usesSessionControlAPI && { maxRedirects: 0 }),
        validateStatus: () => true,
      })
    } catch (error) {
      throw new MemoryServiceError(
        `${config.method ?? 'GET'} ${this.label}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private throwForStatus(
    response: AxiosResponse<unknown>,
    operation: string,
  ): never {
    const detail = responseMessage(response.data)
    const reason = permanentReason(response.status, response.data)
    throw new MemoryServiceError(
      `${operation}: HTTP ${response.status}${detail ? ` (${detail})` : ''}`,
      response.status,
      reason !== undefined,
      reason,
    )
  }

  private assertWritable(operation: string): void {
    if (this.mode === 'ro') {
      throw new MemoryServiceError(
        `${operation} refused on read-only memory mount ${this.label}`,
        undefined,
        true,
      )
    }
  }

  private entryUrl(id: string): string {
    if (!MEMORY_ID_RE.test(id)) {
      throw new MemoryServiceError(`invalid memory id ${id}`, undefined, true)
    }
    return `${this.memoriesUrl}/${encodeURIComponent(id)}`
  }

  async list(options?: {
    pathPrefix?: string
    depthOne?: boolean
  }): Promise<RemoteMemoryEntry[]> {
    const entries: RemoteMemoryEntry[] = []
    let page: string | undefined
    for (;;) {
      const params: Record<string, string | number> = { limit: PAGE_LIMIT }
      if (options?.pathPrefix) params.path_prefix = options.pathPrefix
      if (options?.depthOne) {
        params.depth = 1
        params.order_by = 'path'
        params.order = 'asc'
      }
      if (page) params.page = page
      const response = await this.request<unknown>({
        method: 'GET',
        url: this.memoriesUrl,
        params,
      })
      if (response.status === 404 && page === undefined) {
        throw new MemoryNotFoundError(this.label)
      }
      if (response.status < 200 || response.status >= 300) {
        this.throwForStatus(response, `list ${this.label}`)
      }
      const body = asRecord(response.data)
      const data = body?.data
      if (!Array.isArray(data)) {
        throw new MemoryServiceError(
          `list ${this.label}: malformed response`,
          response.status,
          true,
        )
      }
      for (const raw of data) {
        const item = asRecord(raw)
        if (!item || (item.type !== 'memory' && item.type !== 'memory_metadata')) {
          continue
        }
        if (
          typeof item.id !== 'string' ||
          !MEMORY_ID_RE.test(item.id) ||
          typeof item.content_sha256 !== 'string'
        ) {
          throw new MemoryServiceError(
            `list ${this.label}: malformed memory item`,
            response.status,
            true,
          )
        }
        entries.push({
          id: item.id,
          path: normalizeRemotePath(item.path),
          sha256: item.content_sha256,
          ...(typeof item.content_size_bytes === 'number' && {
            sizeBytes: item.content_size_bytes,
          }),
        })
      }
      if (entries.length > MAX_LIST_ENTRIES) {
        throw new MemoryServiceError(
          `list ${this.label}: exceeded ${MAX_LIST_ENTRIES} entries`,
          response.status,
          true,
        )
      }
      const next = typeof body?.next_page === 'string' ? body.next_page : undefined
      if (!next) return entries
      if (next === page || data.length === 0) {
        throw new MemoryServiceError(
          `list ${this.label}: page cursor did not advance`,
          response.status,
          true,
        )
      }
      page = next
    }
  }

  async read(id: string): Promise<RemoteMemoryDocument> {
    const response = await this.request<unknown>({
      method: 'GET',
      url: this.entryUrl(id),
    })
    if (response.status === 404) throw new MemoryNotFoundError(id)
    if (response.status < 200 || response.status >= 300) {
      this.throwForStatus(response, `read ${this.label}:${id}`)
    }
    const body = asRecord(response.data)
    if (
      !body ||
      typeof body.content !== 'string' ||
      typeof body.content_sha256 !== 'string' ||
      typeof body.updated_at !== 'string'
    ) {
      throw new MemoryServiceError(
        `read ${this.label}:${id}: malformed response`,
        response.status,
        true,
      )
    }
    return {
      id,
      path: typeof body.path === 'string' ? normalizeRemotePath(body.path) : '/',
      content: body.content,
      sha256: body.content_sha256,
      updatedAt: body.updated_at,
    }
  }

  async readByPath(path: string): Promise<RemoteMemoryDocument | null> {
    const normalized = normalizeRemotePath(path)
    const slash = normalized.lastIndexOf('/')
    const prefix = normalized.slice(0, slash + 1)
    let entries: RemoteMemoryEntry[]
    try {
      entries = await this.list({ pathPrefix: prefix, depthOne: true })
    } catch (error) {
      if (error instanceof MemoryNotFoundError) return null
      throw error
    }
    const match = entries.find(entry => entry.path === normalized)
    return match ? this.read(match.id) : null
  }

  async create(path: string, content: string): Promise<RemoteMemoryEntry> {
    this.assertWritable('create')
    const normalized = normalizeRemotePath(path)
    const response = await this.request<unknown>({
      method: 'POST',
      url: this.memoriesUrl,
      data: { path: normalized, content },
    })
    if (response.status === 409) {
      const body = asRecord(response.data)
      const error = asRecord(body?.error)
      let existingId: string | undefined
      if (
        typeof error?.conflicting_memory_id === 'string' &&
        typeof error.conflicting_path === 'string'
      ) {
        try {
          if (normalizeRemotePath(error.conflicting_path) === normalized) {
            existingId = error.conflicting_memory_id
          }
        } catch {
          // A malformed conflicting_path must not lend authority to the id.
        }
      }
      throw new MemoryConflictError(normalized, existingId)
    }
    if (response.status < 200 || response.status >= 300) {
      this.throwForStatus(response, `create ${this.label}:${normalized}`)
    }
    return this.parseMutationResponse(response, normalized)
  }

  async update(
    entry: RemoteMemoryEntry,
    content: string,
  ): Promise<RemoteMemoryEntry> {
    this.assertWritable('update')
    const response = await this.request<unknown>({
      method: 'POST',
      url: this.entryUrl(entry.id),
      data: {
        content,
        precondition: {
          type: 'content_sha256',
          content_sha256: entry.sha256,
        },
      },
    })
    if (response.status === 404) throw new MemoryNotFoundError(entry.id)
    if (response.status === 409) throw new MemoryConflictError(entry.path)
    if (response.status < 200 || response.status >= 300) {
      this.throwForStatus(response, `update ${this.label}:${entry.id}`)
    }
    return this.parseMutationResponse(response, entry.path)
  }

  async delete(entry: RemoteMemoryEntry): Promise<void> {
    this.assertWritable('delete')
    const response = await this.request<unknown>({
      method: 'DELETE',
      url: this.entryUrl(entry.id),
      params: { expected_content_sha256: entry.sha256 },
    })
    // 2.1.221 treats a conditional delete's 404 as a stale basis. Only an
    // unconditional delete is idempotent; this adapter always sends a SHA.
    if (response.status === 404) throw new MemoryNotFoundError(entry.id)
    if (response.status === 409) throw new MemoryConflictError(entry.path)
    if (response.status < 200 || response.status >= 300) {
      this.throwForStatus(response, `delete ${this.label}:${entry.id}`)
    }
  }

  getExportUrl(metadataOnly = false): string {
    return metadataOnly ? `${this.exportUrl}?view=basic` : this.exportUrl
  }

  private parseMutationResponse(
    response: AxiosResponse<unknown>,
    path: string,
  ): RemoteMemoryEntry {
    const body = asRecord(response.data)
    if (
      !body ||
      typeof body.id !== 'string' ||
      !MEMORY_ID_RE.test(body.id) ||
      typeof body.content_sha256 !== 'string'
    ) {
      throw new MemoryServiceError(
        `memory mutation for ${path}: malformed response`,
        response.status,
        true,
      )
    }
    return { id: body.id, path, sha256: body.content_sha256 }
  }
}

export const _memoryBackendInternalsForTesting = {
  normalizeRemotePath,
}
