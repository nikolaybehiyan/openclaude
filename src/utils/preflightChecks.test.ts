import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import axios, { AxiosError } from 'axios'

const testGlobals = globalThis as unknown as { MACRO: typeof MACRO }
const originalMacro = testGlobals.MACRO
const originalOrigin = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
const { checkEndpoints } = await import('./preflightChecks.js')
let get: ReturnType<typeof spyOn<typeof axios, 'get'>>

beforeEach(() => {
  testGlobals.MACRO = { VERSION: 'test' } as typeof MACRO
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
  get = spyOn(axios, 'get')
})

afterEach(() => {
  get.mockRestore()
  testGlobals.MACRO = originalMacro
  if (originalOrigin === undefined) delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  else process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = originalOrigin
})

test('startup requires both real availability endpoints to succeed', async () => {
  get.mockResolvedValue({ status: 200 })
  expect(await checkEndpoints()).toEqual({ success: true })
  expect(get.mock.calls.map(([url]) => url)).toEqual([
    'https://ai.darbmind.ru/api/hello',
    'https://ai.darbmind.ru/v1/oauth/hello',
  ])
})

test.each([
  ['/api/hello', 501],
  ['/v1/oauth/hello', 404],
] as const)('reports the server response for %s, not an internet failure', async (path, status) => {
  get.mockImplementation(async url => {
    if (!String(url).endsWith(path)) return { status: 200 }
    throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
      status, statusText: 'Unavailable', data: {}, headers: {}, config: {} as never,
    })
  })
  expect(await checkEndpoints()).toEqual({
    success: false,
    serverResponse: true,
    error: `ai.darbmind.ru returned HTTP ${status} for ${path}`,
  })
})

test('a non-200 successful HTTP response still fails the availability check', async () => {
  get.mockResolvedValue({ status: 204 })
  expect(await checkEndpoints()).toMatchObject({ success: false, serverResponse: true })
})

test('connection failures remain connection failures', async () => {
  get.mockRejectedValue(new AxiosError('Connection refused', 'ECONNREFUSED'))
  const result = await checkEndpoints()
  expect(result.success).toBe(false)
  expect(result.serverResponse).not.toBe(true)
  expect(result.error).toContain('ECONNREFUSED')
})

test('certificate failures retain the CA guidance', async () => {
  get.mockRejectedValue(Object.assign(new Error('self-signed certificate'), {
    code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  }))
  const result = await checkEndpoints()
  expect(result.success).toBe(false)
  expect(result.serverResponse).not.toBe(true)
  expect(result.sslHint).toContain('NODE_EXTRA_CA_CERTS')
})
