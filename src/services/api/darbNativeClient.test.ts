import {afterAll, expect, mock, test} from 'bun:test'
import type {ClientOptions} from '@anthropic-ai/sdk'
import {NativeGatewaySession, parseNativeGatewayContext} from '../../utils/model/darbNativeGateway.js'

const session = new NativeGatewaySession(parseNativeGatewayContext({version: 2,
  account_uuid: 'native-account', organization_uuid: 'native-org', native_surface: 'cowork',
  catalog: {configuration_mode: 'default', default_model: 'claude-darb-glm', has_more: false, data: [{id: 'claude-darb-glm', type: 'model', display_name: 'GLM',
    max_context_tokens: 1048576, max_input_tokens: 1000000, max_output_tokens: 32000}]}}))
const original = await import('../../utils/model/darbNativeGateway.js')
mock.module('../../utils/model/darbNativeGateway.js', () => ({...original, nativeGatewaySession: session}))
const {getAnthropicClient} = await import('./client.js')
const models = await import('../../utils/model/model.js')
const {validateModel} = await import('../../utils/model/validateModel.js')
const capacity = await import('../../utils/context.js')
const env = {...process.env}, globals = globalThis as Record<string, unknown>, macro = globals.MACRO
afterAll(() => {process.env = env; globals.MACRO = macro; mock.restore()})

test('actual native API client exchanges per request and retry without consulting parent/provider auth', async () => {
  globals.MACRO = {VERSION: 'native-fixture'}
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'parent-never-on-wire'
  process.env.ANTHROPIC_API_KEY = 'provider-never-on-wire'
  process.env.ANTHROPIC_AUTH_TOKEN = 'stale-never-on-wire'
  process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai'
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'Authorization: forged\nx-api-key: forged'
  let minted = 0, sent = 0
  session.setRefresh(async () => `darb-native-inference-v2.fresh-${++minted}`)
  const body = {model: 'claude-darb-glm', max_tokens: 1024, messages: [{role: 'user' as const, content: 'Native unchanged body'}]}
  const client = await getAnthropicClient({maxRetries: 0, model: body.model, fetchOverride: (async (input, init) => {
    const request = new Request(input, init)
    sent++
    expect(request.url).toBe('https://ai.darbmind.ru/v1/messages')
    expect(request.headers.get('authorization')).toBe(`Bearer darb-native-inference-v2.fresh-${sent}`)
    expect(request.headers.has('x-api-key')).toBe(false)
    expect(await request.json()).toEqual(body)
    if (sent === 1) return Response.json({error: {type: 'authentication_error', message: 'fixture expired'}}, {status: 401})
    return Response.json({id: 'msg_native', type: 'message', role: 'assistant', model: body.model, content: [],
      stop_reason: 'end_turn', stop_sequence: null, usage: {input_tokens: 1, output_tokens: 1}})
  }) as NonNullable<ClientOptions['fetch']>})
  await client.messages.create(body)
  await client.messages.create(body)
  expect(sent).toBe(3)
  expect(minted).toBe(3)
  await expect(getAnthropicClient({maxRetries: 0, model: 'missing'})).rejects.toThrow('selected model')
})

test('native defaults and background helpers use owner selection rather than Claude family guesses', () => {
  expect(models.getDefaultMainLoopModel()).toBe('claude-darb-glm')
  expect(models.parseUserSpecifiedModel('default')).toBe('claude-darb-glm')
  for (const getter of [models.getDefaultSonnetModel, models.getDefaultHaikuModel, models.getDefaultOpusModel]) expect(getter()).toBe('claude-darb-glm')
  expect(models.parseUserSpecifiedModel('claude-darb-glm')).toBe('claude-darb-glm')
  expect(capacity.getContextWindowForModel('claude-darb-glm')).toBe(1048576)
  expect(capacity.getModelMaxOutputTokens('claude-darb-glm').upperLimit).toBe(32000)
  expect(capacity.getKnownDarbInputBudget('claude-darb-glm', 32000)).toBe(1000000)
})

test('native startup validates the owner catalog before host control is available, without a probe request', async () => {
  session.setRefresh(async () => {throw Error('host control is not running yet')})
  expect(await validateModel('claude-darb-glm')).toEqual({valid: true})
  expect((await validateModel('unknown')).valid).toBe(false)
})
