import {
  DESIGN_MAX_BODY_BYTES,
  DESIGN_REQUEST_TIMEOUT_MS,
  designBaseURL,
} from './constants.js'

export class DesignHTTPError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'DesignHTTPError'
  }
}

// Do not expose fetch's message/cause verbatim: these can contain credentials,
// request URLs or proxy configuration. Only known transport codes are useful
// for diagnosing the native Web path, and no transport failure is retried here.
const DESIGN_TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

function transportFailureCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 4) return undefined
  const failure = error as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown[] }
  if (typeof failure.code === 'string' && DESIGN_TRANSPORT_CODES.has(failure.code)) {
    return failure.code
  }
  if (failure.name === 'TimeoutError') return 'TIMEOUT'
  const causeCode = transportFailureCode(failure.cause, depth + 1)
  if (causeCode) return causeCode
  if (Array.isArray(failure.errors)) {
    for (const nested of failure.errors.slice(0, 8)) {
      const code = transportFailureCode(nested, depth + 1)
      if (code) return code
    }
  }
  return undefined
}

export class DesignTransportError extends Error {
  constructor(readonly transportCode: string) {
    super(`Claude Design transport failed (${transportCode})`)
    this.name = 'DesignTransportError'
  }
}

function combinedSignal(signal?: AbortSignal, timeoutMS = DESIGN_REQUEST_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Claude Design response exceeds ${maxBytes} bytes`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Claude Design response exceeds ${maxBytes} bytes`)
  }
  return new TextDecoder().decode(bytes)
}

export type DesignFetchResponse = {
  status: number
  headers: Headers
  data: unknown
  contentType: string
}

export async function designJSONFetch(
  path: string,
  token: string,
  init: {
    method?: string
    body?: unknown
    headers?: Record<string, string>
    signal?: AbortSignal
    maxBytes?: number
    timeoutMS?: number
    allowHTTPError?: boolean
  } = {},
): Promise<DesignFetchResponse> {
  const target = `${designBaseURL()}${path}`
  const request: RequestInit = {
    method: init.method ?? 'POST',
    redirect: 'error',
    signal: combinedSignal(init.signal, init.timeoutMS),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }
  let response: Response
  try {
    response = await fetch(target, request)
  } catch (error) {
    if (init.signal?.aborted) throw error
    throw new DesignTransportError(transportFailureCode(error) ?? 'UNKNOWN')
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const text = await readBounded(response, init.maxBytes ?? DESIGN_MAX_BODY_BYTES)
  let data: unknown = text
  if (text !== '' && contentType.includes('json')) {
    try {
      data = JSON.parse(text)
    } catch {
      throw new DesignHTTPError(
        `Claude Design returned invalid JSON (HTTP ${response.status})`,
        response.status,
        undefined,
      )
    }
  }
  if (!response.ok && !init.allowHTTPError) {
    throw new DesignHTTPError(
      `Claude Design failed: HTTP ${response.status}`,
      response.status,
      data,
    )
  }
  return { status: response.status, headers: response.headers, data, contentType }
}
