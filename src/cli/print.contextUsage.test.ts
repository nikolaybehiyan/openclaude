import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { StructuredIO } from './structuredIO.js'
import { Stream } from '../utils/Stream.js'
import { NativeGatewaySession, parseNativeGatewayContext } from '../utils/model/darbNativeGateway.js'

// Exercise the actual dispatch block without booting the interactive CLI or
// making provider calls. StructuredIO and native auth are the real protocol.
const source = readFileSync(new URL('./print.ts', import.meta.url), 'utf8')
const start = source.indexOf("} else if (message.request.subtype === 'get_context_usage') {")
const end = source.indexOf("} else if (message.request.subtype === 'mcp_message') {", start)
if (start < 0 || end < 0) throw Error('Context control handler not found')
const block = source.slice(source.indexOf('\n', start) + 1, end)

function harness() {
  const input = new Stream<string>()
  const io = new StructuredIO(input)
  const controller = new AbortController()
  const session = new NativeGatewaySession(parseNativeGatewayContext({
    version: 2, account_uuid: 'fixture', organization_uuid: 'fixture', native_surface: 'code',
    catalog: { configuration_mode: 'default', default_model: 'fixture-model', has_more: false,
      data: [{ id: 'fixture-model', type: 'model', display_name: 'Fixture',
        max_context_tokens: 100000, max_input_tokens: 90000, max_output_tokens: 1000 }] },
  }))
  session.setRefresh(signal => io.refreshHostAuthToken(signal))
  const events: string[] = [], jobs: Promise<unknown>[] = []
  const responses: { id: string; ok: boolean }[] = []
  const messages = [{ type: 'user', message: { role: 'user', content: 'first' } }]
  const state = { agentDefinitions: {} }
  let snapshot: unknown, snapshotState: unknown, calls = 0
  const collect = async (context: { messages: unknown[]; getAppState: () => unknown }, options: { background: boolean }) => {
    expect(options).toEqual({ background: true })
    snapshot = context.messages
    snapshotState = context.getAppState()
    const response = await session.fetch((async () => {
      calls++
      return Response.json({ input_tokens: 42 })
    }) as typeof fetch)('https://ai.darbmind.ru/v1/messages/count_tokens', {
      method: 'POST', body: JSON.stringify({ model: 'fixture-model', messages: [] }), signal: controller.signal,
    })
    return response.json()
  }
  const handle = new Function('collectContextData', 'getAppState', 'mutableMessages',
    'getMainLoopModel', 'buildAllTools', 'options', 'sendControlResponseSuccess',
    'sendControlResponseError', 'errorMessage', 'trackControlWork',
    `return async function(message) { ${block} }`)(
    collect, () => state, messages, () => 'fixture-model', () => [], {},
    (m: {request_id: string}) => responses.push({id: m.request_id, ok: true}),
    (m: {request_id: string}) => responses.push({id: m.request_id, ok: false}),
    String, (p: Promise<unknown>) => jobs.push(p),
  )
  const pump = (async () => {
    for await (const message of io.structuredInput) {
      if (message.type === 'control_request' && message.request.subtype === 'get_context_usage') {
        await handle(message)
      } else {
        events.push(message.type === 'control_request' ? message.request.subtype : message.type)
      }
    }
  })()
  const send = (message: unknown) => input.enqueue(JSON.stringify(message) + '\n')
  const context = () => send({type: 'control_request', request_id: 'context-1', request: {subtype: 'get_context_usage'}})
  return { send, context, io, events, jobs, responses, messages, state,
    get calls() { return calls }, get snapshot() { return snapshot }, get snapshotState() { return snapshotState },
    async close() { controller.abort(); input.done(); await pump; await Promise.all(jobs) },
  }
}

test('context count reads its host auth reply and the second user turn without deadlock', async () => {
  const h = harness()
  try {
    h.context()
    const request = (await h.io.outbound.next()).value
    expect(request.request.subtype).toBe('host_auth_token_refresh')
    h.send({type: 'control_response', response: {subtype: 'success', request_id: request.request_id,
      response: {authToken: 'darb-native-inference-v2.fixture'}}})
    h.send({type: 'user', session_id: 'fixture', parent_tool_use_id: null,
      message: {role: 'user', content: 'second'}})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.events).toEqual(['user'])
    expect(h.calls).toBe(1)
    expect(h.responses).toEqual([{id: 'context-1', ok: true}])
    expect(h.jobs).toHaveLength(1)
    expect(h.snapshot).not.toBe(h.messages)
    h.messages.push({type: 'user', message: {role: 'user', content: 'later'}})
    expect(h.snapshot).toHaveLength(1)
    expect(h.snapshotState).toBe(h.state)
  } finally { await h.close() }
})

test('interrupt remains readable while context auth is pending; failure is correlated', async () => {
  const h = harness()
  try {
    h.context()
    const request = (await h.io.outbound.next()).value
    h.send({type: 'control_request', request_id: 'stop-1', request: {subtype: 'interrupt'}})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.events).toEqual(['interrupt'])
    expect(h.responses).toEqual([])
    h.send({type: 'control_response', response: {subtype: 'error', request_id: request.request_id, error: 'fixture denied'}})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.calls).toBe(0)
    expect(h.responses).toEqual([{id: 'context-1', ok: false}])
  } finally { await h.close() }
})
