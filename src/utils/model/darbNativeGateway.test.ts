import { expect, test } from 'bun:test'
import { NativeGatewaySession, parseNativeGatewayContext } from './darbNativeGateway.js'

const row = { id: 'claude-darb-glm', type: 'model', display_name: 'GLM', max_context_tokens: 1048576, max_input_tokens: 1000000, max_output_tokens: 32000,
  native_parameters: {version: 1, thinking_types: ['enabled'], effort_values: ['low', 'high', 'max']} }
const fixture = () => ({version: 2, account_uuid: 'account', organization_uuid: 'org', native_surface: 'cowork',
  catalog: {configuration_mode: 'default', default_model: 'claude-darb-qwen', has_more: false, data: [row, {...row, id: 'claude-darb-qwen', max_context_tokens: 262144, max_input_tokens: 240000}]}})
const request = (model = row.id) => new Request('https://ai.darbmind.ru/v1/messages', {method: 'POST', body: JSON.stringify({model, messages: []}),
  headers: {Authorization: 'Bearer parent-must-not-escape', 'x-api-key': 'provider-must-not-escape', 'x-internal-service-token': 'internal', 'x-darb-context-window-tokens': '200000'}})

test('native account catalog preserves exact per-model capacity and controls', () => {
  const session = new NativeGatewaySession(parseNativeGatewayContext(fixture()))
  expect(session.model(row.id).max_context_tokens).toBe(1048576)
  expect(session.context.defaultModel).toBe('claude-darb-qwen')
  expect(session.model('claude-darb-qwen').max_context_tokens).toBe(262144)
  expect(session.model(row.id + '[1m]').max_context_tokens).toBe(1048576)
  expect(session.model(row.id).native_parameters?.effort_values).toEqual(['low', 'high', 'max'])
  expect(() => session.model('sonnet')).toThrow('selected model')
  expect(() => session.model('unknown')).toThrow('selected model')
})

test('native bootstrap rejects partial, custom and credential-bearing context', () => {
  for (const patch of [{version: 1}, {account_uuid: ''}, {native_surface: 'cli'}, {token: 'secret'}, {base_url: 'https://api.z.ai'}]) {
    expect(() => parseNativeGatewayContext({...fixture(), ...patch})).toThrow()
  }
  for (const catalog of [{configuration_mode: 'custom', has_more: false, data: [row]},
    {...fixture().catalog, default_model: undefined}, {...fixture().catalog, default_model: 'hidden'},
    {configuration_mode: 'default', has_more: true, data: [row]},
    {configuration_mode: 'default', has_more: false, data: [{id: row.id, display_name: 'GLM', type: 'model'}]}]) {
    expect(() => parseNativeGatewayContext({...fixture(), catalog})).toThrow()
  }
})

test('each request and retry obtains a new limited bearer; parent/provider/header overrides never escape', async () => {
  const session = new NativeGatewaySession(parseNativeGatewayContext(fixture()))
  let mints = 0
  session.setRefresh(async () => `darb-native-inference-v2.fixture-${++mints}`)
  const received: Request[] = []
  const send = session.fetch((async input => {
    const r = input as Request
    received.push(r)
    expect(r.headers.get('Authorization')).toBe(`Bearer darb-native-inference-v2.fixture-${received.length}`)
    for (const header of ['x-api-key', 'x-internal-service-token', 'x-darb-context-window-tokens']) expect(r.headers.has(header)).toBe(false)
    expect(r.redirect).toBe('error')
    expect((await r.json()).model).toBe(row.id)
    return new Response('{}', {status: received.length === 1 ? 401 : 200})
  }) as typeof fetch)
  expect((await send(request())).status).toBe(200)
  expect((await send(request())).status).toBe(200)
  expect(mints).toBe(3)
})

test('a rejected refresh, foreign origin, unknown model or redirect cannot fall back', async () => {
  for (const token of [null, '', 'parent-oauth', 'provider-key', 'darb-native-inference-v2.', 'darb-native-inference-v2.bad token']) {
    const session = new NativeGatewaySession(parseNativeGatewayContext(fixture()))
    session.setRefresh(async () => token)
    let calls = 0
    await expect(session.fetch((async (_input: RequestInfo | URL) => { calls++; return new Response('{}') }) as typeof fetch)(request())).rejects.toThrow()
    expect(calls).toBe(0)
  }
  const session = new NativeGatewaySession(parseNativeGatewayContext(fixture()))
  let mints = 0, calls = 0
  session.setRefresh(async () => { mints++; return 'darb-native-inference-v2.test' })
  const send = session.fetch((async (_input: RequestInfo | URL) => { calls++; return new Response('{}') }) as typeof fetch)
  for (const url of ['https://api.z.ai/v1/messages', 'https://ai.darbmind.ru.evil/v1/messages', 'https://ai.darbmind.ru:444/v1/messages', 'https://ai.darbmind.ru/api/profile']) {
    await expect(send(url)).rejects.toThrow('destination')
  }
  await expect(send(request('other'))).rejects.toThrow('selected model')
  expect(mints).toBe(0)
  expect(calls).toBe(0)
})

test('parallel sessions keep their own host callbacks and model catalogs', async () => {
  const a = new NativeGatewaySession(parseNativeGatewayContext(fixture()))
  const b = new NativeGatewaySession(parseNativeGatewayContext({...fixture(), account_uuid: 'other-account'}))
  a.setRefresh(async () => 'darb-native-inference-v2.account-a')
  b.setRefresh(async () => 'darb-native-inference-v2.account-b')
  const headers: string[] = []
  const collect = (async r => { headers.push((r as Request).headers.get('Authorization')!); return new Response('{}') }) as typeof fetch
  await Promise.all([a.fetch(collect)(request()), b.fetch(collect)(request())])
  expect(headers.sort()).toEqual(['Bearer darb-native-inference-v2.account-a', 'Bearer darb-native-inference-v2.account-b'])
})
