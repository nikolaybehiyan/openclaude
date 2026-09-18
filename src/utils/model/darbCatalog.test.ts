import { describe, expect, test } from 'bun:test'
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { DarbCatalogSession, guardDarbFetch, parseDarbCatalog } from './darbCatalog.js'

const connection = 'icn_' + 'a'.repeat(32)
const digest = 'sha256:' + 'b'.repeat(64)
function payload(id = 'Vendor/DeepSeek-V3[1m]') {
  return {
    configuration_mode: 'custom',
    data: [{ id, display_name: 'Reasoning model', connection_id: connection,
      connection_revision: 4, catalog_revision: digest, capabilities: { tools: true } }],
    has_more: false,
    saved_selection: { connection_id: connection, connection_revision: 4, model: id, catalog_revision: digest },
  }
}
function customCatalog(value:unknown) {
  const catalog=parseDarbCatalog(value)
  if(catalog.mode!=='custom')throw Error('Expected custom fixture')
  return catalog
}

describe('Darb catalog contract', () => {
  test('accepts the public owner explicit-default shape without a custom selection or icn binding', () => {
    // sdk_inference.go handleSDKModels projects these exact fields from the
    // default Org policy. No private owner/credential metadata is on this API.
    const data = {configuration_mode:'default',data:[{id:'claude-sonnet-4-6',type:'model' as const,display_name:'Sonnet 4.6'}],has_more:false,first_id:'claude-sonnet-4-6',last_id:'claude-sonnet-4-6'}
    const catalog = parseDarbCatalog(data)
    expect(catalog.mode).toBe('default')
    if(catalog.mode!=='default')throw Error('Expected default fixture')
    expect(catalog.models).toEqual(data.data)
    expect(catalog.defaultModel).toBeUndefined()
    expect(Object.isFrozen(catalog.models[0])).toBe(true)
    expect(JSON.stringify(catalog)).not.toContain('connection_id')
  })

  test('unknown, incomplete, unconfigured and mixed-mode catalogs cannot restore native default behavior', () => {
    for (const value of [
      {...payload(),configuration_mode:'unknown'},
      {...payload(),status:'unconfigured'},
      {...payload(),status:'unknown'},
      {...payload(),configuration_mode:'default'},
      {configuration_mode:'custom',data:[],has_more:false,status:'unconfigured'},
      {configuration_mode:'default',data:[],has_more:false},
      {configuration_mode:'default',data:[{id:'claude-sonnet-4-6',display_name:'Sonnet 4.6'}],has_more:false},
      {configuration_mode:'default',data:[{id:'claude-sonnet-4-6',type:'model',display_name:'Sonnet 4.6'}],has_more:true},
    ]) expect(() => parseDarbCatalog(value)).toThrow()
  })
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

  test('canonical owner per-model state preserves null, off and exact effort without selecting defaults', () => {
    const p = payload()
    const first = p.data[0]!
    Object.assign(first,{capabilities:{reasoning_support:'unknown',effort_support:'unknown',parameter_contract:{version:1,codec:'anthropic_messages',thinking:{enabled:'unknown',adaptive:'unsupported',disabled:'unknown'},effort:{support:'unknown',values:['Vendor.Exact']},reasoning_required:null}},thinking:{type:'effort_and_mode',mode_options:[{id:'off',name:''}],effort_options:[{id:'Vendor.Exact',name:'Exact'}]}})
    p.data.push({...first,id:'Second/Exact[1m]'})
    Object.assign(p,{native_selector_state:{model:first.id,thinking:null,thinking_by_model:[{id:first.id,thinking:null},{id:'Second/Exact[1m]',thinking:{type:'effort_and_mode',mode:'off',effort:'Vendor.Exact'}}]}})
    const catalog=customCatalog(p)
    expect(catalog.models[0]?.selected_thinking).toBeNull()
    expect(catalog.models[1]?.selected_thinking).toEqual({type:'effort_and_mode',mode:'off',effort:'Vendor.Exact'})
    expect(catalog.models[0]?.thinking?.mode_options).toEqual([{id:'off',name:''}])
    expect(catalog.models[0]?.reasoning_support).toBe('unknown')
    expect(catalog.defaultModel).toBe(first.id)
    Object.assign(p,{native_selector_state:{thinking:{type:'mode',mode:'auto'}}})
    expect(()=>parseDarbCatalog(p)).toThrow('unavailable')
    Object.assign(p,{native_selector_state:{thinking_by_model:[{id:'foreign',thinking:null}]}})
    expect(()=>parseDarbCatalog(p)).toThrow('state changed')
  })

  test('context capability and explicit standard selection do not change the model ID', () => {
    const p = payload()
    Object.assign(p.data[0]!, { supports_1m: true, context_window_tokens: 1000000 })
    expect(customCatalog(p).models[0]?.context_window_tokens).toBe(1000000)
    Object.assign(p.saved_selection, { context_window_tokens: 0 })
    const standard = customCatalog(p).models[0]!
    expect(standard.id).toBe(p.saved_selection.model)
    expect(standard.context_window_tokens).toBe(0)
    Object.assign(p.saved_selection, { context_window_tokens: 1000000 })
    Object.assign(p.data[0]!, { supports_1m: false })
    expect(() => parseDarbCatalog(p)).toThrow('context capability')
  })

  test('empty and legacy catalogs require connection setup instead of selecting the first model', () => {
    expect(() => parseDarbCatalog({ data: [], has_more: false })).toThrow('Connect AI')
    expect(() => parseDarbCatalog({ data: [{ id: 'claude-sonnet-5' }], has_more: false })).toThrow('Connect AI')
  })

  test('gateway capacity is optional and validated independently of the selected variant', () => {
    expect(customCatalog(payload()).models[0]?.max_input_tokens).toBeUndefined()
    for (const max_input_tokens of [128000, 262144, 1000000]) {
      const p = payload()
      Object.assign(p.data[0]!, { max_input_tokens })
      expect(customCatalog(p).models[0]?.max_input_tokens).toBe(max_input_tokens)
    }
    for (const max_input_tokens of [0, -1, 0.5, null, '128000', Number.MAX_SAFE_INTEGER + 1]) {
      const p = payload()
      Object.assign(p.data[0]!, { max_input_tokens })
      expect(() => parseDarbCatalog(p)).toThrow()
    }
    const p = payload()
    Object.assign(p.data[0]!, { supports_1m: true, context_window_tokens: 1000000, max_input_tokens: 128000 })
    expect(() => parseDarbCatalog(p)).toThrow('context capability')
  })

  test('output capacity keeps its own optional exact numeric field', () => {
    expect(customCatalog(payload()).models[0]?.max_output_tokens).toBeUndefined()
    for (const max_output_tokens of [4096, 8192, 65536]) {
      const p = payload()
      Object.assign(p.data[0]!, { max_output_tokens })
      const row = customCatalog(p).models[0]!
      expect(row.max_output_tokens).toBe(max_output_tokens)
      expect(row.max_input_tokens).toBeUndefined()
    }
    for (const max_output_tokens of [0, -1, 0.5, '8192', null, Number.MAX_SAFE_INTEGER + 1]) {
      const p = payload()
      Object.assign(p.data[0]!, { max_output_tokens })
      expect(() => parseDarbCatalog(p)).toThrow()
    }
  })

  test('total context remains distinct and optional; rejects malformed capacity and contradictory 1M', () => {
    expect(customCatalog(payload()).models[0]?.max_context_tokens).toBeUndefined()
    const p = payload()
    Object.assign(p.data[0]!, { max_context_tokens: 131072 })
    const row = customCatalog(p).models[0]!
    expect(row.max_context_tokens).toBe(131072)
    expect(row.max_input_tokens).toBeUndefined()
    expect(row.context_window_tokens).toBe(0)
    for (const max_context_tokens of [0, -1, 0.5, '131072', null, Number.MAX_SAFE_INTEGER + 1]) {
      Object.assign(p.data[0]!, { max_context_tokens })
      expect(() => parseDarbCatalog(p)).toThrow('context capability')
    }
    Object.assign(p.data[0]!, { max_context_tokens: 131072, supports_1m: true, context_window_tokens: 1000000 })
    expect(() => parseDarbCatalog(p)).toThrow('context capability')
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
  test('explicit default SDK transport preserves native model and features while stripping all custom binding headers', async () => {
    let seen=0
    const body={model:'claude-sonnet-4-6',max_tokens:64,thinking:{type:'enabled' as const,budget_tokens:32},messages:[{role:'user' as const,content:'Original default history'}],tools:[{name:'fixture',input_schema:{type:'object' as const}}]}
    const client=new Anthropic({baseURL:'https://ai.darbmind.ru',apiKey:null,authToken:'fixture-default-oauth',maxRetries:0,
      defaultHeaders:{'x-darb-connection-id':connection,'x-darb-context-window-tokens':'1000000','x-sdk-catalog-revision':digest},
      fetch:guardDarbFetch((async (input:Request)=>{
        seen++;expect(await input.json()).toEqual(body)
        expect(input.headers.get('authorization')).toBe('Bearer fixture-default-oauth')
        input.headers.forEach((_value,name)=>expect(name).not.toMatch(/^x-(darb|sdk)-(connection|catalog|context)-/))
        return Response.json({id:'msg_default',type:'message',role:'assistant',model:body.model,content:[],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}})
      }) as NonNullable<ClientOptions['fetch']>,'https://ai.darbmind.ru',undefined,()=>true)})
    await client.messages.create(body);expect(seen).toBe(1)
  })
  test('real Anthropic SDK preserves prompt/tools/history while binding the exact connection', async () => {
    const binding = customCatalog(payload()).models[0]!
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
    const binding = customCatalog(payload()).models[0]!
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
