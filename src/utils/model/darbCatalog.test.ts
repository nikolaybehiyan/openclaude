import { describe, expect, test } from 'bun:test'
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { DarbCatalogSession, guardDarbFetch, parseDarbCatalog } from './darbCatalog.js'

const connection = 'icn_' + 'a'.repeat(32)
const digest = 'sha256:' + 'b'.repeat(64)
function payload(id = 'Vendor/DeepSeek-V3[1m]') {
  return {
    data: [{ id, display_name: 'Reasoning model', connection_id: connection,
      connection_revision: 4, catalog_revision: digest, capabilities: { tools: true } }],
    has_more: false,
    saved_selection: { connection_id: connection, connection_revision: 4, model: id, catalog_revision: digest },
  }
}

describe('Darb catalog contract', () => {
  test('keeps real case, namespaces and suffixes; does not store arbitrary owner fields', () => {
    const data = payload()
    Object.assign(data.data[0]!, { api_key: 'must-not-enter-cache', base_url: 'https://provider.example' })
    const catalog = parseDarbCatalog(data)
    expect(catalog.defaultModel).toBe('Vendor/DeepSeek-V3[1m]')
    expect(JSON.stringify(catalog)).not.toContain('must-not-enter-cache')
    expect(JSON.stringify(catalog)).not.toContain('provider.example')
    expect(Object.isFrozen(catalog.models[0])).toBe(true)
  })

  test('a literal sonnet model is not remapped', () => {
    expect(parseDarbCatalog(payload('sonnet')).defaultModel).toBe('sonnet')
  })

  test('empty and legacy catalogs require connection setup instead of selecting the first model', () => {
    expect(() => parseDarbCatalog({ data: [], has_more: false })).toThrow('Connect AI')
    expect(() => parseDarbCatalog({ data: [{ id: 'claude-sonnet-5' }], has_more: false })).toThrow('Connect AI')
  })

  test('rejects missing default, duplicate IDs, mixed connections, stale revision and digest', () => {
    for (const mutate of [
      (p: ReturnType<typeof payload>) => { p.saved_selection.model = 'unknown' },
      (p: ReturnType<typeof payload>) => { p.saved_selection.connection_revision++ },
      (p: ReturnType<typeof payload>) => { p.saved_selection.catalog_revision = 'sha256:' + 'c'.repeat(64) },
      (p: ReturnType<typeof payload>) => { p.data.push({ ...p.data[0]! }) },
      (p: ReturnType<typeof payload>) => { p.data.push({ ...p.data[0]!, id: 'Other', connection_id: 'icn_' + 'c'.repeat(32) }) },
    ]) {
      const p = payload(); mutate(p)
      expect(() => parseDarbCatalog(p)).toThrow()
    }
  })

  test('rejects terminal escapes, unsafe revision numbers and incomplete pagination', () => {
    for (const mutate of [
      (p: ReturnType<typeof payload>) => { p.data[0]!.display_name = '\x1b[31m' },
      (p: ReturnType<typeof payload>) => { p.data[0]!.connection_revision = Number.MAX_SAFE_INTEGER + 1 },
      (p: ReturnType<typeof payload>) => { p.has_more = true },
    ]) {
      const p = payload(); mutate(p)
      expect(() => parseDarbCatalog(p)).toThrow()
    }
  })

  test('old account and concurrent responses cannot repopulate a revoked catalog', () => {
    const state = new DarbCatalogSession()
    const a = state.begin('account-A')
    const b = state.begin('account-B')
    state.complete('account-B', b, payload('B'))
    state.complete('account-A', a, payload('A'))
    expect(state.current('account-A')).toBeUndefined()
    expect(state.current('account-B')?.defaultModel).toBe('B')
    state.begin('account-B')
    state.complete('account-B', b, payload('stale'))
    expect(state.current('account-B')).toBeUndefined()
    expect(state.current(undefined)).toBeUndefined()
  })
})

describe('Darb native SDK transport', () => {
  test('real Anthropic SDK preserves prompt/tools/history while binding the exact connection', async () => {
    const binding = parseDarbCatalog(payload()).models[0]!
    const body = {
      model: binding.id, max_tokens: 100,
      system: [{ type: 'text' as const, text: 'Do not rewrite me', cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'user' as const, content: 'Ask one question' }],
      tools: [{ name: 'ask_user_input_v0', input_schema: { type: 'object' as const, properties: { questions: { type: 'array' } } } }],
    }
    let seen = 0
    const fetcher = (async (input: Request) => {
      seen++
      expect(await input.json()).toEqual(body)
      expect(input.headers.get('x-darb-connection-id')).toBe(connection)
      expect(input.headers.get('x-darb-connection-revision')).toBe('4')
      expect(input.headers.get('x-darb-catalog-revision')).toBe(digest)
      expect(input.headers.has('x-sdk-connection-id')).toBe(false)
      expect(input.headers.get('authorization')).toBe('Bearer fixture-oauth')
      expect(input.redirect).toBe('error')
      return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: binding.id,
        content: [{ type: 'text', text: 'Fixture response', citations: null }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } })
    }) as NonNullable<ClientOptions['fetch']>
    const client = new Anthropic({ baseURL: 'https://ai.darbmind.ru', apiKey: null, authToken: 'fixture-oauth',
      maxRetries: 0, defaultHeaders: { 'X-Darb-Connection-Id': 'forged', 'x-sdk-connection-id': 'forged' },
      fetch: guardDarbFetch(fetcher, 'https://ai.darbmind.ru', binding, () => true) })
    const response = await client.messages.create(body)
    expect(response.content).toEqual([{ type: 'text', text: 'Fixture response', citations: null }])
    expect(seen).toBe(1)
  })

  test('no transmission after logout/account switch, model rewrite or destination change', async () => {
    const binding = parseDarbCatalog(payload()).models[0]!
    let count = 0
    const fetcher = async () => { count++; return Response.json({}) }
    const invoke = (current: boolean, url: string, model: string) =>
      guardDarbFetch(fetcher, 'https://ai.darbmind.ru', binding, () => current)(url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) })
    await expect(invoke(false, 'https://ai.darbmind.ru/v1/messages', binding.id)).rejects.toThrow('account changed')
    await expect(invoke(true, 'https://evil.example/v1/messages', binding.id)).rejects.toThrow('destination changed')
    await expect(invoke(true, 'https://ai.darbmind.ru/v1/messages', 'claude-sonnet-5')).rejects.toThrow('model changed')
    expect(count).toBe(0)
  })
})
