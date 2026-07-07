import { expect, test } from 'bun:test'
import { connectSdkMcpServers } from './permissions.js'

test('SDK MCP tool isError becomes a thrown tool-call error', async () => {
  const text = 'memory files did not change; requested memory edit was not saved; update/create native memory files and retry'
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
