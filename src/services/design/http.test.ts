import { afterEach, describe, expect, test } from 'bun:test'
import { designJSONFetch, DesignHTTPError, DesignTransportError } from './http.js'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe('Design native transport diagnostics', () => {
  test('retains an allowlisted cause code without leaking request data or retrying', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new TypeError('fetch failed https://user:secret@private.invalid', {
        cause: Object.assign(new Error('token=secret'), { code: 'ECONNREFUSED' }),
      })
    }) as typeof fetch
    try {
      await designJSONFetch('/private?token=secret', 'secret')
      throw new Error('expected transport failure')
    } catch (error) {
      expect(error).toBeInstanceOf(DesignTransportError)
      expect((error as Error).message).toBe('Claude Design transport failed (ECONNREFUSED)')
      expect((error as Error).cause).toBeUndefined()
      expect(JSON.stringify(error)).not.toContain('secret')
    }
    expect(calls).toBe(1)
  })

  test('recognizes nested aggregate connection failures and redacts unknown codes', async () => {
    for (const [error, code] of [
      [new TypeError('fetch failed', { cause: new AggregateError([
        Object.assign(new Error('private address'), { code: 'ENETUNREACH' }),
      ]) }), 'ENETUNREACH'],
      [new DOMException('private URL', 'TimeoutError'), 'TIMEOUT'],
      [Object.assign(new Error('private URL'), { code: 'private-secret' }), 'UNKNOWN'],
    ] as const) {
      globalThis.fetch = (async () => { throw error }) as typeof fetch
      await expect(designJSONFetch('/GetProject', 'test-token'))
        .rejects.toThrow(`Claude Design transport failed (${code})`)
    }
  })

  test('preserves caller cancellation without wrapping or retrying', async () => {
    const controller = new AbortController()
    const cancellation = new DOMException('cancelled', 'AbortError')
    controller.abort()
    globalThis.fetch = (async () => { throw cancellation }) as typeof fetch
    try {
      await designJSONFetch('/GetProject', 'test-token', { signal: controller.signal })
      throw new Error('expected cancellation')
    } catch (error) {
      expect(error).toBe(cancellation)
    }
  })

  test('preserves HTTP authorization errors and successful response parsing', async () => {
    globalThis.fetch = (async () => Response.json({ error: 'unauthorized' }, { status: 401 })) as typeof fetch
    try {
      await designJSONFetch('/GetProject', 'test-token')
      throw new Error('expected HTTP authorization failure')
    } catch (error) {
      expect(error).toBeInstanceOf(DesignHTTPError)
      expect((error as DesignHTTPError).status).toBe(401)
    }
    globalThis.fetch = (async () => Response.json({ projectId: 'project-test' })) as typeof fetch
    expect((await designJSONFetch('/GetProject', 'test-token')).data)
      .toEqual({ projectId: 'project-test' })
  })
})
