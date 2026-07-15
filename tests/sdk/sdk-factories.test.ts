import { describe, test, expect } from 'bun:test'
import {
  tool,
  createSdkMcpServer,
  createSdkClientMcpServer,
} from '../../src/entrypoints/sdk/index.js'

describe('tool() factory', () => {
  test('creates SdkMcpToolDefinition with required fields', () => {
    const handler = async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    })
    const def = tool('read_file', 'Read a file', { path: 'string' }, handler)

    expect(def.name).toBe('read_file')
    expect(def.description).toBe('Read a file')
    expect(def.inputSchema).toEqual({ path: 'string' })
    expect(def.handler).toBe(handler)
    expect(def.annotations).toBeUndefined()
    expect(def.searchHint).toBeUndefined()
    expect(def.alwaysLoad).toBeUndefined()
  })

  test('includes optional extras when provided', () => {
    const handler = async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    })
    const def = tool('search', 'Search files', { query: 'string' }, handler, {
      annotations: { readOnlyHint: true },
      searchHint: 'file-search',
      alwaysLoad: true,
      _meta: { ui: { resourceUri: 'ui://search/results.html' } },
    })

    expect(def.annotations).toEqual({ readOnlyHint: true })
    expect(def.searchHint).toBe('file-search')
    expect(def.alwaysLoad).toBe(true)
    expect(def._meta).toEqual({ ui: { resourceUri: 'ui://search/results.html' } })
  })

  test('handler can return CallToolResult', async () => {
    const handler = async (args: any) => ({
      content: [{ type: 'text' as const, text: `File: ${args.path}` }],
    })
    const def = tool('read', 'Read', { path: 'string' }, handler)

    const result = await def.handler({ path: '/tmp/test.txt' }, undefined)
    expect(result.content).toEqual([
      { type: 'text', text: 'File: /tmp/test.txt' },
    ])
  })
})

describe('createSdkMcpServer()', () => {
  test('wraps stdio config with session scope', () => {
    const config = createSdkMcpServer({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'some-server'],
    })

    expect(config.type).toBe('stdio')
    expect(config.command).toBe('npx')
    expect(config.args).toEqual(['-y', 'some-server'])
    expect(config.scope).toBe('session')
  })

  test('wraps sse config with session scope', () => {
    const config = createSdkMcpServer({
      type: 'sse',
      url: 'http://localhost:3001/sse',
      headers: { Authorization: 'Bearer token' },
    })

    expect(config.type).toBe('sse')
    expect(config.url).toBe('http://localhost:3001/sse')
    expect(config.scope).toBe('session')
  })

  test('wraps http config with session scope', () => {
    const config = createSdkMcpServer({
      type: 'http',
      url: 'http://localhost:3001/mcp',
    })

    expect(config.type).toBe('http')
    expect(config.url).toBe('http://localhost:3001/mcp')
    expect(config.scope).toBe('session')
  })

  test('preserves all original fields', () => {
    const config = createSdkMcpServer({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'test' },
    })

    expect(config.command).toBe('node')
    expect(config.args).toEqual(['server.js'])
    expect((config as any).env).toEqual({ API_KEY: 'test' })
  })
})

describe('createSdkClientMcpServer()', () => {
  test('keeps OpenClaude tool definitions while delegating only execution', async () => {
    const calls: any[] = []
    const server = createSdkClientMcpServer({
      name: 'Apple Notes',
      tools: [{
        name: 'search_notes',
        description: 'Search local notes',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        permissionBehavior: 'allow',
        alwaysLoad: true,
        _meta: { ui: { resourceUri: 'ui://apple-notes/search.html' } },
      }],
      async callTool(call) {
        calls.push(call)
        return { content: [{ type: 'text', text: 'one result' }] }
      },
    })

    expect(server.type).toBe('sdk')
    expect(server.scope).toBe('session')
    expect(server.name).toBe('Apple Notes')
    const definition = server.tools?.[0]
    expect(definition?.name).toBe('search_notes')
    expect(definition?.permissionBehavior).toBe('allow')
    expect(definition?._meta).toEqual({ ui: { resourceUri: 'ui://apple-notes/search.html' } })
    const result = await definition?.handler({ query: 'roadmap' }, { context: { toolUseId: 'toolu-1' } })
    expect(result?.content).toEqual([{ type: 'text', text: 'one result' }])
    expect(calls).toEqual([{
      serverName: 'Apple Notes',
      toolName: 'search_notes',
      args: { query: 'roadmap' },
      extra: { context: { toolUseId: 'toolu-1' } },
    }])
  })

  test('rejects duplicate tool names within one client-hosted server', () => {
    expect(() => createSdkClientMcpServer({
      name: 'Duplicate server',
      tools: [
        { name: 'same', description: 'first', inputSchema: {} },
        { name: 'same', description: 'second', inputSchema: {} },
      ],
      async callTool() {
        return { content: [] }
      },
    })).toThrow('duplicate tool same')
  })
})
