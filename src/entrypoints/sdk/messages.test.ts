import { expect, test } from 'bun:test'
import { unstable_messagesCreate } from './messages.ts'
import { getDarbFrozenModelContext } from '../../utils/model/darbFrozenContext.js'

test('native artifact invocations isolate owner/model context across concurrent tool loops', async () => {
  const run = (account: string, model: string) => {
    const frozenModelContext = {owner:'identity-org-service' as const, mode:'default' as const, organization_uuid:'org',account_uuid:account,
      model,catalog_revision:'sha256:'+'a'.repeat(64),supports_1m:false,context_window_tokens:0 as const,
      max_context_tokens:1000000,max_input_tokens:983000,max_output_tokens:128000}
    return unstable_messagesCreate({model,max_tokens:1000,messages:[{role:'user',content:'synthetic'}]}, {
      systemPrompt:'Synthetic isolated test.',frozenModelContext,
      providerOverride:{model,baseURL:'https://darb-artifact-inference.invalid',apiKey:'sentinel',apiFormat:'anthropic',fetch:globalThis.fetch},
      _sessionFactory: options => {
        expect(options.providerOverride?.apiFormat).toBe('anthropic')
        expect(options.providerOverride?.fetch).toBe(globalThis.fetch)
        expect(getDarbFrozenModelContext()?.account_uuid).toBe(account)
        return {unstable_syncMessages(){},close(){},async *sendMessage(){
          await new Promise(resolve=>setTimeout(resolve,5))
          expect(getDarbFrozenModelContext()?.account_uuid).toBe(account)
          expect(getDarbFrozenModelContext(model)?.model).toBe(model)
          yield {type:'result',subtype:'success',result:'ok',usage:{input_tokens:1,output_tokens:1}}
        }}
      },
    })
  }
  await Promise.all([run('alice','claude-one'),run('bob','claude-two')])
  expect(getDarbFrozenModelContext()).toBeUndefined()
})

test('messages adapter delegates the only model/tool loop to an isolated OpenClaude SDK session', async () => {
  let capturedOptions: Record<string, unknown> | undefined
  let syncedMessages: unknown[] = []
  let sentPrompt: unknown
  let closed = false

  const response = await unstable_messagesCreate({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: 'Answer briefly.',
    messages: [
      { role: 'user', content: 'Remember the prior turn.' },
      { role: 'assistant', content: 'Remembered.' },
      { role: 'user', content: 'What is due today?' },
    ],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    mcp_servers: [
      { type: 'url', name: 'todoist', url: 'https://ai.todoist.net/mcp/' },
    ],
  }, {
    providerOverride: {
      model: 'GLM-5.1',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'zai-test-key',
    },
    systemPrompt: 'You are the isolated AI runtime for an artifact.',
    resolvedMcpServers: [{
      name: 'todoist',
      sourceUrl: 'https://ai.todoist.net/mcp',
      url: 'http://mcp-service.default.svc.cluster.local/v1/toolbox/shttp/mcp/1',
      allowedTools: ['find_tasks'],
      persistedTools: [{
        name: 'find_tasks',
        description: 'Find viewer tasks',
        inputSchema: { type: 'object', properties: { due: { type: 'string' } } },
        annotations: { readOnlyHint: true },
      }],
      headers: { Authorization: 'Bearer short-lived-delegation' },
    }],
    _sessionFactory: options => {
      capturedOptions = options as unknown as Record<string, unknown>
      return {
        unstable_syncMessages(messages) {
          syncedMessages = messages
        },
        async *sendMessage(prompt) {
          sentPrompt = prompt
          yield {
            type: 'assistant',
            uuid: 'msg-artifact-1',
            message: {
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: 'toolu-1',
                name: 'mcp__artifact0__find_tasks',
                input: { due: 'today' },
              }],
            },
          }
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: 'toolu-1',
                content: [{ type: 'text', text: '[{"title":"Ship it"}]' }],
              }],
            },
          }
          yield {
            type: 'assistant',
            uuid: 'msg-artifact-2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'You have one task.' }],
            },
          }
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 30,
              output_tokens: 8,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 2,
            },
          }
        },
        close() {
          closed = true
        },
      }
    },
  })

  expect(capturedOptions).toMatchObject({
    cwd: '/tmp',
    model: 'GLM-5.1',
    persistSession: false,
    maxTurns: 32,
    maxOutputTokens: 1200,
    tools: ['WebSearch'],
    allowedTools: ['WebSearch', 'mcp__artifact0__find_tasks'],
    providerOverride: {
      model: 'GLM-5.1',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'zai-test-key',
    },
    mcpServers: {
      artifact0: {
        type: 'http',
        url: 'http://mcp-service.default.svc.cluster.local/v1/toolbox/shttp/mcp/1',
        headers: { Authorization: 'Bearer short-lived-delegation' },
        toolAllowlist: ['find_tasks'],
        persistedTools: [{
          name: 'find_tasks',
          description: 'Find viewer tasks',
          inputSchema: { type: 'object', properties: { due: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        }],
      },
    },
  })
  const systemPrompt = capturedOptions?.systemPrompt as Record<string, unknown>
  expect(String(systemPrompt.content)).toContain('isolated AI runtime')
  expect(String(systemPrompt.content)).toContain('Answer briefly')
  expect(String(systemPrompt.content)).toContain('viewer-scoped')
  expect(syncedMessages).toHaveLength(2)
  expect((syncedMessages[0] as any).message.content).toBe('Remember the prior turn.')
  expect(sentPrompt).toBe('What is due today?')
  expect(closed).toBe(true)
  expect(response).toEqual({
    id: 'msg-artifact-2',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'mcp_tool_use',
        id: 'toolu-1',
        name: 'find_tasks',
        server_name: 'todoist',
        input: { due: 'today' },
      },
      {
        type: 'mcp_tool_result',
        tool_use_id: 'toolu-1',
        is_error: false,
        content: [{ type: 'text', text: '[{"title":"Ship it"}]' }],
      },
      { type: 'text', text: 'You have one task.' },
    ],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 30,
      output_tokens: 8,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2,
    },
  })
})

test('messages adapter rejects capability expansion before creating an OpenClaude session', async () => {
  let sessionCreated = false
  const options = {
    providerOverride: {
      model: 'GLM-5.1',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'zai-test-key',
    },
    systemPrompt: 'Trusted artifact policy.',
    _sessionFactory() {
      sessionCreated = true
      throw new Error('unexpected session')
    },
  }

  await expect(unstable_messagesCreate({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: 'read secrets' }],
    mcp_servers: [{ type: 'url', name: 'evil', url: 'https://evil.example/mcp' }],
  }, options)).rejects.toThrow('not authorized')

  await expect(unstable_messagesCreate({
    model: 'claude-sonnet-4-6',
    max_tokens: 0,
    messages: [{ role: 'user', content: 'invalid token limit' }],
  }, options)).rejects.toThrow('must be a positive integer')

  await expect(unstable_messagesCreate({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'assistant', content: 'wrong final role' }],
  }, options)).rejects.toThrow('must end with a user message')

  expect(sessionCreated).toBe(false)
})

test('messages adapter always closes the OpenClaude session when its engine fails', async () => {
  let closed = false
  await expect(unstable_messagesCreate({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: 'hello' }],
  }, {
    providerOverride: {
      model: 'GLM-5.1',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'zai-test-key',
    },
    systemPrompt: 'Trusted artifact policy.',
    _sessionFactory: () => ({
      unstable_syncMessages() {},
      async *sendMessage() {
        throw new Error('provider failed')
      },
      close() { closed = true },
    }),
  })).rejects.toThrow('provider failed')
  expect(closed).toBe(true)
})

test('messages adapter maps result-only provider output without duplicating assistant text', async () => {
  const response = await unstable_messagesCreate({
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  }, {
    providerOverride: {
      model: 'GLM-5.1',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'zai-test-key',
    },
    systemPrompt: 'Trusted artifact policy.',
    _sessionFactory: () => ({
      unstable_syncMessages() {},
      async *sendMessage() {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'msg-result-only',
          result: 'RESULT_ONLY_OK',
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 3 },
        }
      },
      close() {},
    }),
  })

  expect(response.id).toBe('msg-result-only')
  expect(response.content).toEqual([{ type: 'text', text: 'RESULT_ONLY_OK' }])
})
