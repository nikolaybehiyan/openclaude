import {
  DESIGN_MAX_BODY_BYTES,
  DESIGN_PROJECT_TYPE,
  DESIGN_RPC_SERVICE,
  DESIGN_SYNC_CLIENT,
} from '../../services/design/constants.js'
import { designJSONFetch, DesignHTTPError } from '../../services/design/http.js'

export class DesignRpcError extends DesignHTTPError {
  constructor(
    readonly method: string,
    status: number,
    body: unknown,
  ) {
    super(`Design API ${method} failed: HTTP ${status}`, status, body)
    this.name = status === 401 || status === 403 ? 'DesignAuthError' : 'DesignRpcError'
  }
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Design API returned an invalid response')
  }
  return value as Record<string, any>
}

export async function callDesignRPC(
  method: string,
  token: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  try {
    const response = await designJSONFetch(
      `/${DESIGN_RPC_SERVICE}/${method}`,
      token,
      {
        body,
        signal,
        maxBytes: DESIGN_MAX_BODY_BYTES,
        headers: { 'X-Anthropic-Client': DESIGN_SYNC_CLIENT },
      },
    )
    return record(response.data)
  } catch (error) {
    if (error instanceof DesignHTTPError) {
      throw new DesignRpcError(method, error.status, error.body)
    }
    throw error
  }
}

export async function listDesignSystemProjects(
  token: string,
  signal?: AbortSignal,
) {
  const items: Record<string, any>[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const response = await callDesignRPC(
      'ListOrgProjects',
      token,
      { type: DESIGN_PROJECT_TYPE, ...(cursor ? { cursor } : {}) },
      signal,
    )
    if (Array.isArray(response.items)) items.push(...response.items)
    cursor = typeof response.cursor === 'string' && response.cursor ? response.cursor : undefined
    if (!cursor) return items
  }
  return items
}

export function getDesignProject(
  token: string,
  projectId: string,
  signal?: AbortSignal,
) {
  return callDesignRPC('GetProject', token, { projectId }, signal)
}

export async function listDesignProjectFiles(
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const paths: string[] = []
  let offset = 0
  for (let page = 0; page < 50; page += 1) {
    const response = await callDesignRPC(
      'ListFiles',
      token,
      { projectId, depth: -1, ...(offset > 0 ? { offset } : {}) },
      signal,
    )
    const entries = Array.isArray(response.entries) ? response.entries : []
    for (const entry of entries) {
      if (typeof entry?.path === 'string') paths.push(entry.path)
    }
    if (response.truncated !== true || entries.length === 0) return paths
    offset += entries.length
  }
  return paths
}

const TEXT_CONTENT_TYPES = /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/i

export async function getDesignProjectFile(
  token: string,
  projectId: string,
  path: string,
  signal?: AbortSignal,
) {
  const response = await callDesignRPC(
    'GetFile',
    token,
    { projectId, path, raw: true },
    signal,
  )
  const encoded = typeof response.content === 'string' ? response.content : ''
  const contentType =
    typeof response.contentType === 'string'
      ? response.contentType
      : 'application/octet-stream'
  const isBase64 = !TEXT_CONTENT_TYPES.test(contentType)
  if (isBase64) {
    return { content: encoded, contentType, isBase64: true, truncated: false }
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const limit = 256 * 1024
  return {
    content: decoded.slice(0, limit),
    contentType,
    isBase64: false,
    truncated: decoded.length > limit,
  }
}

export async function writeDesignProjectFiles(
  token: string,
  projectId: string,
  files: Array<Record<string, unknown>>,
  signal?: AbortSignal,
) {
  const response = await callDesignRPC(
    'WriteFiles',
    token,
    { projectId, files, deduplicate: false },
    signal,
  )
  return Array.isArray(response.files) ? response.files : []
}

export async function deleteDesignProjectFiles(
  token: string,
  projectId: string,
  paths: string[],
  signal?: AbortSignal,
) {
  const response = await callDesignRPC(
    'DeleteFiles',
    token,
    { projectId, paths },
    signal,
  )
  return Array.isArray(response.deleted) ? response.deleted : paths
}

export async function createDesignSystemProject(
  token: string,
  name: string,
  signal?: AbortSignal,
) {
  const response = await callDesignRPC(
    'CreateProject',
    token,
    { name, type: DESIGN_PROJECT_TYPE },
    signal,
  )
  if (typeof response.projectId !== 'string' || !response.projectId) {
    throw new DesignRpcError('CreateProject', 200, response)
  }
  return { projectId: response.projectId, name }
}

export async function recordDesignAsset(
  token: string,
  projectId: string,
  asset: {
    name: string
    path: string
    subtitle?: string
    viewport?: { width: number; height?: number }
    group?: string
  },
  signal?: AbortSignal,
) {
  await callDesignRPC(
    'RecordAsset',
    token,
    {
      projectId,
      name: asset.name,
      path: asset.path,
      ...(asset.subtitle ? { subtitle: asset.subtitle } : {}),
      ...(asset.viewport ? { viewport: asset.viewport } : {}),
      ...(asset.group ? { section: asset.group } : {}),
    },
    signal,
  )
}

export async function deleteDesignAsset(
  token: string,
  projectId: string,
  path: string,
  signal?: AbortSignal,
) {
  await callDesignRPC('DeleteAsset', token, { projectId, path }, signal)
}
