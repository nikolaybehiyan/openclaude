import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  callDesignRPC,
  listDesignProjectFiles,
  listDesignSystemProjects,
} from './client.js'

const originalFetch = globalThis.fetch
const originalOauthBase = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL

beforeEach(() => {
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalOauthBase === undefined) {
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  } else {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = originalOauthBase
  }
})

describe('DesignSync direct RPC transport', () => {
  test('uses the exact service URL, client header, bearer and camel-case body', async () => {
    let request: { url: string; init?: RequestInit } | undefined
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init }
      return new Response(JSON.stringify({ projectId: 'p' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await callDesignRPC('GetProject', 'secret-token', { projectId: 'p' })

    expect(request?.url).toBe(
      'https://ai.darbmind.ru/anthropic.omelette.api.v1alpha.OmeletteService/GetProject',
    )
    expect(request?.init?.method).toBe('POST')
    expect(request?.init?.redirect).toBe('error')
    expect(new Headers(request?.init?.headers).get('authorization')).toBe(
      'Bearer secret-token',
    )
    expect(new Headers(request?.init?.headers).get('x-anthropic-client')).toBe(
      'claude-cli-design-sync',
    )
    expect(request?.init?.body).toBe('{"projectId":"p"}')
  })

  test('paginates project cursors and file offsets without changing DTO names', async () => {
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      const isProjects = 'type' in body
      const data = isProjects
        ? body.cursor
          ? { items: [{ projectId: 'p2' }] }
          : { items: [{ projectId: 'p1' }], cursor: 'next' }
        : body.offset
          ? { entries: [{ path: 'b.html' }], truncated: false }
          : { entries: [{ path: 'a.html' }], truncated: true }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    expect(await listDesignSystemProjects('token')).toHaveLength(2)
    expect(await listDesignProjectFiles('token', 'p')).toEqual([
      'a.html',
      'b.html',
    ])
    expect(bodies).toEqual([
      { type: 'PROJECT_TYPE_DESIGN_SYSTEM' },
      { type: 'PROJECT_TYPE_DESIGN_SYSTEM', cursor: 'next' },
      { projectId: 'p', depth: -1 },
      { projectId: 'p', depth: -1, offset: 1 },
    ])
  })
})
