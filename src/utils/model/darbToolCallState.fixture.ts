// Cross-language test fixture only. Both SDK HTTP requests and model output are
// synthetic; the Go integration test feeds native SSE over stdin.
import Anthropic from '@anthropic-ai/sdk'
import assert from 'node:assert/strict'
import { normalizeMessagesForAPI, stripCallerFieldFromAssistantMessage } from '../messages.js'
import { getDarbFrozenModelContext } from './darbFrozenContext.js'

if (import.meta.main) {
  globalThis.fetch = async () => { throw new Error('fixture_network_disabled') }
  const input = JSON.parse(await Bun.stdin.text()) as { sse: string; model: string }
  assert.equal(getDarbFrozenModelContext()?.model, input.model)
  let requests = 0
  const client = new Anthropic({
    apiKey: 'synthetic-sdk-key', maxRetries: 0,
    fetch: async () => {
      requests++
      return new Response(input.sse, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const stream = client.beta.messages.stream({
    model: input.model, max_tokens: 64,
    messages: [{ role: 'user', content: 'synthetic input' }],
  })
  const message = await stream.finalMessage()
  assert.equal(requests, 1)
  const calls = message.content.filter(b => b.type === 'tool_use')
  assert.ok(calls.length > 0)
  for (const call of calls) assert.equal(typeof (call as any).darb_tool_call_state, 'string')
  const assistant = {
    type: 'assistant', uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-09-15T00:00:00Z', message,
  } as any
  // Exercise the independent model-specific caller stripping path as well.
  const stripped = stripCallerFieldFromAssistantMessage({
    ...assistant, message: { ...message, content: message.content.map(b => b.type === 'tool_use' ? { ...b, caller: { type: 'direct' } } : b) },
  })
  const result = {
    type: 'user', uuid: '00000000-0000-4000-8000-000000000002',
    timestamp: '2026-09-15T00:00:01Z',
    message: { role: 'user', content: calls.map(call => ({ type: 'tool_result', tool_use_id: call.id, content: 'synthetic result' })) },
  } as any
  const normalized = normalizeMessagesForAPI([stripped, result], [])
  const replayCalls = normalized.find(m => m.type === 'assistant')!.message.content.filter((b: any) => b.type === 'tool_use')
  assert.deepEqual(replayCalls.map((b: any) => [b.id, b.name, b.input, b.darb_tool_call_state]), calls.map((b: any) => [b.id, b.name, b.input, b.darb_tool_call_state]))
  process.stdout.write(JSON.stringify({ model: input.model, max_tokens: 64, messages: normalized.map(m => ({ role: m.message.role, content: m.message.content })) }))
}
