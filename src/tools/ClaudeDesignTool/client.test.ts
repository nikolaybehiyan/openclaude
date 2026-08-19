import { beforeEach, describe, expect, mock, test } from 'bun:test'

type FetchCall = {
  path: string
  token: string
  init: Record<string, any>
}

let calls: FetchCall[] = []
let handler: (call: FetchCall) => Promise<Record<string, any>>

mock.module('../../services/design/auth.js', () => ({
  resolveDesignAccessToken: async () => ({
    ok: true as const,
    accessToken: 'token-a',
  }),
  refreshDesignAccessTokenAfter401: async () => 'token-b',
}))

mock.module('../../services/design/http.js', () => ({
  designJSONFetch: async (
    path: string,
    token: string,
    init: Record<string, any>,
  ) => {
    const call = { path, token, init }
    calls.push(call)
    return handler(call)
  },
}))

const {
  callClaudeDesignOperation,
  DesignConsentRequiredError,
  DesignProjectGrantRequiredError,
  resetDesignSessionCacheForTests,
} = await import('./client.js')

function response(
  data: Record<string, any>,
  options: { status?: number; session?: string; contentType?: string } = {},
) {
  return {
    status: options.status ?? 200,
    headers: new Headers(
      options.session ? { 'mcp-session-id': options.session } : {},
    ),
    data,
    contentType: options.contentType ?? 'application/json',
  }
}

beforeEach(() => {
  calls = []
  resetDesignSessionCacheForTests()
})

describe('ClaudeDesign native MCP transport', () => {
  test('initializes, discovers, and calls with exact protocol/session DTOs', async () => {
    handler = async call => {
      if (call.init.body.method === 'initialize') {
        return response({ jsonrpc: '2.0', id: 0, result: {} }, { session: 's1' })
      }
      if (call.init.body.method === 'tools/list') {
        return response({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              {
                name: 'read_file',
                annotations: { readOnlyHint: true, destructiveHint: false },
              },
            ],
          },
        })
      }
      return response({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ok' }] },
      })
    }

    const output = await callClaudeDesignOperation(
      'read_file',
      { project_id: 'p', path: 'index.html' },
      new AbortController().signal,
    )

    expect(output).toEqual({
      operation: 'read_file',
      content: [{ type: 'text', text: 'ok' }],
    })
    expect(calls.map(call => call.init.body)).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'claude-cli-design-tool', version: '1' },
        },
      },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'read_file',
          arguments: { project_id: 'p', path: 'index.html' },
        },
      },
    ])
    expect(calls.every(call => call.path === '/v1/design/mcp')).toBe(true)
    expect(calls[0]?.init.headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      Accept: 'application/json, text/event-stream',
      'X-Anthropic-Client': 'claude-cli-design-tool',
    })
    expect(calls[1]?.init.headers['Mcp-Session-Id']).toBe('s1')
    expect(calls[2]?.init.headers['Mcp-Session-Id']).toBe('s1')
  })

  test('refreshes once after 401 without leaking the failed token', async () => {
    let first = true
    handler = async call => {
      if (first) {
        first = false
        return response({}, { status: 401 })
      }
      if (call.init.body.method === 'initialize') {
        return response({ result: {} }, { session: 's2' })
      }
      if (call.init.body.method === 'tools/list') {
        return response({ result: { tools: [] } })
      }
      return response({ result: { content: [] } })
    }

    await callClaudeDesignOperation(
      'list',
      {},
      new AbortController().signal,
    )

    expect(calls.slice(0, 2).map(call => call.token)).toEqual([
      'token-a',
      'token-b',
    ])
  })

  test('rejects event-stream responses instead of parsing a second protocol', async () => {
    handler = async () =>
      response({}, { contentType: 'text/event-stream; charset=utf-8' })
    await expect(
      callClaudeDesignOperation(
        'list',
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('only handles JSON')
  })

  test('maps the canonical consent 403 to a typed permission signal', async () => {
    handler = async call => {
      if (call.init.body.method === 'initialize') {
        return response({ result: {} }, { session: 's3' })
      }
      if (call.init.body.method === 'tools/list') {
        return response({
          result: {
            tools: [
              {
                name: 'read_file',
                annotations: { readOnlyHint: true },
              },
            ],
          },
        })
      }
      return response(
        { error: 'needs_consent', consent: 'agent_design_projects' },
        { status: 403 },
      )
    }

    await expect(
      callClaudeDesignOperation(
        'read_file',
        { project_id: 'p', path: 'x' },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(DesignConsentRequiredError)
  })

  test('maps only a bounded canonical project-grant 403 to a typed permission signal', async () => {
    handler = async call => {
      if (call.init.body.method === 'initialize') {
        return response({ result: {} }, { session: 's4' })
      }
      if (call.init.body.method === 'tools/list') {
        return response({
          result: {
            tools: [
              {
                name: 'write_files',
                annotations: { readOnlyHint: false },
              },
            ],
          },
        })
      }
      return response(
        { error: 'needs_project_grant', project_id: 'project-1' },
        { status: 403 },
      )
    }

    await expect(
      callClaudeDesignOperation(
        'write_files',
        {
          project_id: 'project-1',
          files: [{ path: 'slides/intro.html', data: '<h1>Hello</h1>' }],
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(DesignProjectGrantRequiredError)
  })
})
