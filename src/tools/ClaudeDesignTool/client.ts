import {
  DESIGN_CONSENT_BIT,
  DESIGN_MCP_AGGREGATE_RESULT_CHARS,
  DESIGN_MCP_CLIENT,
  DESIGN_MCP_MAX_CONTENT_BYTES,
  DESIGN_MCP_PATH,
  DESIGN_MCP_PROTOCOL_VERSION,
} from '../../services/design/constants.js'
import {
  refreshDesignAccessTokenAfter401,
  resolveDesignAccessToken,
} from '../../services/design/auth.js'
import { designJSONFetch } from '../../services/design/http.js'
import type {
  DesignMcpContent,
  DesignMcpTool,
} from '../../services/design/types.js'
import { installDesignCatalog, resetDesignCatalogForTests } from './catalog.js'

type MCPResponse = {
  jsonrpc?: string
  id?: number
  result?: {
    tools?: DesignMcpTool[]
    content?: DesignMcpContent[]
    isError?: boolean
  }
  error?: { message?: string; data?: unknown }
}

type RawMCPResponse = {
  status: number
  headers: Headers
  data: MCPResponse
}

export type ClaudeDesignClientDependencies = {
  resolveAccessToken: typeof resolveDesignAccessToken
  refreshAccessTokenAfter401: typeof refreshDesignAccessTokenAfter401
  jsonFetch: typeof designJSONFetch
}

const defaultClientDependencies: ClaudeDesignClientDependencies = {
  resolveAccessToken: resolveDesignAccessToken,
  refreshAccessTokenAfter401: refreshDesignAccessTokenAfter401,
  jsonFetch: designJSONFetch,
}

export class DesignConsentRequiredError extends Error {
  constructor(readonly consent = DESIGN_CONSENT_BIT) {
    super('Claude Design consent required')
    this.name = 'DesignConsentRequiredError'
  }
}

export class DesignProjectGrantRequiredError extends Error {
  constructor(readonly projectId: string) {
    super('Claude Design project grant required')
    this.name = 'DesignProjectGrantRequiredError'
  }
}

let sessionId: string | null = null
let initialized = false
let initializing: Promise<string | null> | null = null
let discovery: Promise<DesignMcpTool[]> | null = null

function asMCPResponse(value: unknown): MCPResponse {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as MCPResponse)
    : {}
}

async function requestMCP(
  body: Record<string, unknown>,
  token: string,
  currentSession: string | null,
  signal: AbortSignal,
  dependencies: ClaudeDesignClientDependencies,
  retried = false,
): Promise<RawMCPResponse> {
  const response = await dependencies.jsonFetch(DESIGN_MCP_PATH, token, {
    method: 'POST',
    body,
    signal,
    maxBytes: DESIGN_MCP_MAX_CONTENT_BYTES,
    allowHTTPError: true,
    headers: {
      'anthropic-version': '2023-06-01',
      Accept: 'application/json, text/event-stream',
      'X-Anthropic-Client': DESIGN_MCP_CLIENT,
      ...(currentSession ? { 'Mcp-Session-Id': currentSession } : {}),
    },
  })
  if (response.status === 401 && !retried && !signal.aborted) {
    const refreshed = await dependencies.refreshAccessTokenAfter401(
      token,
      signal,
    )
    if (refreshed && refreshed !== token) {
      return requestMCP(
        body,
        refreshed,
        currentSession,
        signal,
        dependencies,
        true,
      )
    }
  }
  if (response.contentType.startsWith('text/event-stream')) {
    throw new Error(
      'Claude Design returned a text/event-stream response; this client only handles JSON.',
    )
  }
  return {
    status: response.status,
    headers: response.headers,
    data: asMCPResponse(response.data),
  }
}

async function ensureSession(
  token: string,
  signal: AbortSignal,
  dependencies: ClaudeDesignClientDependencies,
): Promise<string | null> {
  if (initialized) return sessionId
  if (initializing) return initializing
  const pending = (async () => {
    const response = await requestMCP(
      {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: DESIGN_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: DESIGN_MCP_CLIENT, version: '1' },
        },
      },
      token,
      null,
      signal,
      dependencies,
    )
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Claude Design initialize failed: HTTP ${response.status}`,
      )
    }
    sessionId = response.headers.get('mcp-session-id') || null
    initialized = true
    return sessionId
  })()
  initializing = pending
  try {
    return await pending
  } finally {
    if (initializing === pending) initializing = null
  }
}

async function discoverTools(
  token: string,
  signal: AbortSignal,
  dependencies: ClaudeDesignClientDependencies,
): Promise<DesignMcpTool[]> {
  if (discovery) return discovery
  const pending = (async () => {
    let currentSession = await ensureSession(token, signal, dependencies)
    let response = await requestMCP(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      token,
      currentSession,
      signal,
      dependencies,
    )
    if (response.status === 404 && currentSession) {
      resetDesignSessionCacheForTests()
      currentSession = await ensureSession(token, signal, dependencies)
      response = await requestMCP(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        token,
        currentSession,
        signal,
        dependencies,
      )
    }
    const tools = response.data.result?.tools
    if (
      response.status < 200 ||
      response.status >= 300 ||
      !Array.isArray(tools)
    ) {
      throw new Error(`Claude Design discovery failed: HTTP ${response.status}`)
    }
    return installDesignCatalog(tools)
  })()
  discovery = pending
  try {
    return await pending
  } finally {
    if (discovery === pending) discovery = null
  }
}

function parse403(data: MCPResponse): never {
  const payload = data as unknown as Record<string, unknown>
  if (
    payload.error === 'needs_consent' &&
    payload.consent === DESIGN_CONSENT_BIT
  ) {
    throw new DesignConsentRequiredError()
  }
  if (
    payload.error === 'needs_project_grant' &&
    typeof payload.project_id === 'string' &&
    payload.project_id.length > 0 &&
    payload.project_id.length <= 78 &&
    /^[A-Za-z0-9._-]+$/.test(payload.project_id)
  ) {
    throw new DesignProjectGrantRequiredError(payload.project_id)
  }
  throw new Error('Claude Design request forbidden (HTTP 403)')
}

function cappedContent(content: DesignMcpContent[]): DesignMcpContent[] {
  let remaining = DESIGN_MCP_AGGREGATE_RESULT_CHARS
  const accepted: DesignMcpContent[] = []
  let omitted = 0
  let omittedCharacters = 0
  for (const block of content) {
    const size =
      block.type === 'text' && typeof block.text === 'string'
        ? block.text.length
        : block.type === 'image' && typeof block.data === 'string'
          ? block.data.length
          : JSON.stringify(block).length
    if (size <= remaining) {
      remaining -= size
      accepted.push(block)
    } else {
      omitted += 1
      omittedCharacters += size
    }
  }
  if (omitted > 0) {
    accepted.push({
      type: 'text',
      text: `[ClaudeDesign result truncated — ${omitted} block(s) (${Math.round(omittedCharacters / 1024)}k chars) omitted; aggregate over ${Math.round(DESIGN_MCP_AGGREGATE_RESULT_CHARS / 1024)}k-char cap]`,
    })
  }
  return accepted
}

export async function callClaudeDesignOperation(
  operation: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{
  operation: string
  content: DesignMcpContent[]
  isError?: boolean
}> {
  return callClaudeDesignOperationWithDependencies(
    operation,
    args,
    signal,
    defaultClientDependencies,
  )
}

export async function callClaudeDesignOperationWithDependencies(
  operation: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  dependencies: ClaudeDesignClientDependencies,
): Promise<{
  operation: string
  content: DesignMcpContent[]
  isError?: boolean
}> {
  const auth = await dependencies.resolveAccessToken(signal)
  if (!auth.ok) {
    throw new Error(`Claude Design authentication unavailable: ${auth.reason}`)
  }
  const token = auth.accessToken
  const tools = await discoverTools(token, signal, dependencies)
  if (operation === 'list') {
    return {
      operation,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? '',
              inputSchema: tool.inputSchema ?? {},
            })),
          }),
        },
      ],
    }
  }

  let currentSession = await ensureSession(token, signal, dependencies)
  let response = await requestMCP(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: operation, arguments: args },
    },
    token,
    currentSession,
    signal,
    dependencies,
  )
  if (response.status === 404 && currentSession) {
    resetDesignSessionCacheForTests()
    currentSession = await ensureSession(token, signal, dependencies)
    response = await requestMCP(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: operation, arguments: args },
      },
      token,
      currentSession,
      signal,
      dependencies,
    )
  }
  if (response.status === 403) parse403(response.data)
  if (response.status === 401) {
    throw new Error('Claude Design authentication failed (HTTP 401)')
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Claude Design ${operation} failed: HTTP ${response.status}`,
    )
  }
  if (response.data.error) {
    return {
      operation,
      content: [
        {
          type: 'text',
          text: `${response.data.error.message ?? 'Unknown error'}${response.data.error.data ? ` — ${JSON.stringify(response.data.error.data)}` : ''}`,
        },
      ],
      isError: true,
    }
  }
  return {
    operation,
    content: cappedContent(response.data.result?.content ?? []),
    ...(response.data.result?.isError ? { isError: true } : {}),
  }
}

export function resetDesignSessionCacheForTests(): void {
  sessionId = null
  initialized = false
  initializing = null
  discovery = null
  resetDesignCatalogForTests()
}
