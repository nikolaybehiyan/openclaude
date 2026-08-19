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
  const response = await fetch(`${designBaseURL()}${path}`, {
    method: init.method ?? 'POST',
    redirect: 'error',
    signal: combinedSignal(init.signal, init.timeoutMS),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
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
