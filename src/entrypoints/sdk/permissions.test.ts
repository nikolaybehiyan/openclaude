import { expect, test } from 'bun:test'
import {
  connectSdkMcpServers,
  filterSdkMcpToolsByAllowlist,
} from './permissions.js'

test('SDK MCP tool isError becomes a thrown tool-call error', async () => {
  const text = 'tool handler reported a user-visible error'
  const { tools } = await connectSdkMcpServers({
    memory: {
      type: 'sdk',
      name: 'memory',
      tools: [{
        name: 'memory_user_edits',
        inputSchema: { type: 'object' },
        handler: async () => ({
          isError: true,
          content: [{ type: 'text', text }],
        }),
      }],
    },
  })

  expect(tools).toHaveLength(1)
  await expect(tools[0]!.call(
    {},
    {} as any,
    async () => ({ behavior: 'allow' }),
    {} as any,
    () => {},
  )).rejects.toThrow(text)
})

test('SDK MCP tool can defer JSON schema validation to handler', async () => {
  const calls: unknown[] = []
  const { tools } = await connectSdkMcpServers({
    memory: {
      type: 'sdk',
      name: 'memory',
      tools: [{
        name: 'memory_user_edits',
        inputSchema: {
          type: 'object',
          properties: {
            line_number: { type: 'integer' },
          },
        },
        deferInputValidationToHandler: true,
        handler: async args => {
          calls.push(args)
          return { content: [{ type: 'text', text: 'handled' }] }
        },
      }],
    },
  })

  const validation = await tools[0]!.validateInput?.({ line_number: '1' }, {} as any)
  expect(validation).toEqual({ result: true })
  const result = await tools[0]!.call(
    { line_number: '1' },
    {} as any,
    async () => ({ behavior: 'allow' }),
    {} as any,
    () => {},
  )
  expect(result.data).toEqual([{ type: 'text', text: 'handled' }])
  expect(calls).toEqual([{ line_number: '1' }])
})

test('projected SDK MCP tool preserves native MCP identity and schema', async () => {
  const { tools } = await connectSdkMcpServers({
    pubmed: {
      type: 'sdk',
      name: 'persisted:PubMed',
      tools: [{
        name: 'mcp__PubMed__search_articles',
        description: 'Search PubMed',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string' } },
        },
        annotations: { readOnlyHint: true },
        mcpInfo: { serverName: 'PubMed', toolName: 'search_articles' },
        handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      }],
    },
  })

  expect(tools).toHaveLength(1)
  expect(tools[0]!.name).toBe('mcp__PubMed__search_articles')
  expect(tools[0]!.mcpInfo).toEqual({ serverName: 'PubMed', toolName: 'search_articles' })
  expect(tools[0]!.inputJSONSchema).toEqual({
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' } },
  })
  expect(tools[0]!.isReadOnly({})).toBe(true)
})

test('session MCP allowlist filters on upstream MCP tool names', () => {
  const tools = [
    { name: 'mcp__calendar__search', mcpInfo: { serverName: 'calendar', toolName: 'search' } },
    { name: 'mcp__calendar__delete', mcpInfo: { serverName: 'calendar', toolName: 'delete' } },
  ] as any
  expect(filterSdkMcpToolsByAllowlist(tools, new Set(['search']))).toEqual([tools[0]])
  expect(filterSdkMcpToolsByAllowlist(tools, undefined)).toBe(tools)
})
