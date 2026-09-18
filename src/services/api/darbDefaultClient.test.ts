import {afterAll,afterEach,beforeEach,expect,mock,test} from 'bun:test'
import type {ClientOptions} from '@anthropic-ai/sdk'
import {parseDarbCatalog,type DarbCatalog} from '../../utils/model/darbCatalog.js'
import {makeDarbSessionBinding} from '../../utils/model/darbSessionBinding.js'

const original=await import('../../utils/model/darbModels.js')
let scope:string|undefined='fixture-account/fixture-org'
let catalog:DarbCatalog|undefined
mock.module('../../utils/model/darbModels.js',()=>({...original,
  isDarbManagedInference:()=>true,isDarbCustomInference:()=>catalog?.mode!=='default',
  darbModelScope:()=>scope,currentDarbCatalog:()=>catalog,
  requireDarbModel:(id:string)=>{const row=catalog?.mode==='custom'?catalog.models.find(row=>row.id===id):undefined;if(!row)throw Error('Connect AI');return row},
}))
const {getAnthropicClient}=await import('./client.js')
const storage=await import('../../utils/sessionStorage.js')
const {clearOAuthTokenCache}=await import('../../utils/auth.js')
const env={...process.env},globals=globalThis as Record<string,unknown>,macro=globals.MACRO
const defaultPayload=()=>({configuration_mode:'default',data:[{id:'claude-sonnet-4-6',type:'model',display_name:'Sonnet 4.6'}],has_more:false,first_id:'claude-sonnet-4-6',last_id:'claude-sonnet-4-6'})
beforeEach(()=>{
  globals.MACRO={VERSION:'test-version'};scope='fixture-account/fixture-org';catalog=parseDarbCatalog(defaultPayload())
  for(const name of Object.keys(process.env))if(name.startsWith('ANTHROPIC_')||name.startsWith('CLAUDE_CODE_USE_'))delete process.env[name]
  process.env.ANTHROPIC_BASE_URL='https://ai.darbmind.ru';process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL='https://ai.darbmind.ru'
  process.env.CLAUDE_CODE_OAUTH_TOKEN='fixture-only-default-oauth';process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY='1'
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  storage.resetProjectForTesting();clearOAuthTokenCache()
})
afterEach(()=>{storage.resetProjectForTesting();process.env={...env};globals.MACRO=macro;clearOAuthTokenCache()})
afterAll(()=>mock.restore())

test('actual API client default path retains native OAuth/protocol and strips inherited custom headers',async()=>{
  process.env.ANTHROPIC_CUSTOM_HEADERS='x-darb-connection-id: forged\nx-sdk-catalog-revision: forged\nx-darb-context-window-tokens: 1000000'
  let sent=0
  const body={model:'claude-sonnet-4-6',max_tokens:64,messages:[{role:'user' as const,content:'Unchanged default prompt'}]}
  const client=await getAnthropicClient({maxRetries:0,model:body.model,fetchOverride:(async(input,init)=>{
    sent++;const request=new Request(input,init)
    expect(request.url).toBe('https://ai.darbmind.ru/v1/messages')
    expect(request.headers.get('authorization')).toBe('Bearer fixture-only-default-oauth')
    expect(request.headers.has('x-api-key')).toBe(false)
    request.headers.forEach((_value,name)=>expect(name).not.toMatch(/^x-(darb|sdk)-(connection|catalog|context)-/))
    expect(await request.json()).toEqual(body)
    return Response.json({id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}})
  }) as NonNullable<ClientOptions['fetch']>})
  await client.messages.create(body);expect(sent).toBe(1)
})

test('actual managed custom API client retains OAuth and exact binding through the native fetch wrapper',async()=>{
  const connection={connection_id:'icn_'+'c'.repeat(32),connection_revision:4,catalog_revision:'sha256:'+'d'.repeat(64)}
  catalog=parseDarbCatalog({configuration_mode:'custom',data:[{...connection,id:'Vendor/Exact[1m]',display_name:'Exact'}],has_more:false,saved_selection:{...connection,model:'Vendor/Exact[1m]'}})
  process.env.ANTHROPIC_CUSTOM_HEADERS='x-darb-connection-id: forged\nx-sdk-catalog-revision: forged'
  let sent=0
  const body={model:'Vendor/Exact[1m]',max_tokens:64,messages:[{role:'user' as const,content:'Exact custom history'}]}
  const client=await getAnthropicClient({maxRetries:0,model:body.model,fetchOverride:(async(input,init)=>{
    sent++;const request=new Request(input,init)
    expect(request.headers.get('authorization')).toBe('Bearer fixture-only-default-oauth')
    expect(request.headers.get('x-darb-connection-id')).toBe(connection.connection_id)
    expect(request.headers.get('x-darb-connection-revision')).toBe('4')
    expect(request.headers.get('x-darb-catalog-revision')).toBe(connection.catalog_revision)
    expect(request.headers.get('x-darb-context-window-tokens')).toBe('0')
    expect(request.headers.has('x-sdk-catalog-revision')).toBe(false)
    expect(await request.json()).toEqual(body)
    return Response.json({id:'msg_custom',type:'message',role:'assistant',model:body.model,content:[],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}})
  }) as NonNullable<ClientOptions['fetch']>})
  await client.messages.create(body);expect(sent).toBe(1)
})

test('missing catalog and restored custom history fail before client creation; an old default client is fenced after refresh',async()=>{
  let sent=0;const options={maxRetries:0,model:'claude-sonnet-4-6',fetchOverride:(async()=>{sent++;return Response.json({})}) as NonNullable<ClientOptions['fetch']>}
  catalog=undefined;await expect(getAnthropicClient(options)).rejects.toThrow('Connect AI')
  catalog=parseDarbCatalog(defaultPayload())
  const custom=parseDarbCatalog({configuration_mode:'custom',data:[{id:'Vendor/Exact',display_name:'Exact',connection_id:'icn_'+'a'.repeat(32),connection_revision:1,catalog_revision:'sha256:'+'b'.repeat(64)}],has_more:false,saved_selection:{model:'Vendor/Exact',connection_id:'icn_'+'a'.repeat(32),connection_revision:1,catalog_revision:'sha256:'+'b'.repeat(64)}})
  if(custom.mode!=='custom')throw Error('fixture')
  storage.restoreSessionMetadata({darbInferenceBinding:makeDarbSessionBinding(scope!,custom.models[0]!)})
  await expect(getAnthropicClient(options)).rejects.toThrow('No history was sent')
  storage.clearSessionMetadata()
  const client=await getAnthropicClient(options)
  catalog=parseDarbCatalog(defaultPayload())
  await expect((async()=>await client.messages.create({model:options.model,max_tokens:64,messages:[{role:'user',content:'Do not transmit after refresh'}]}))()).rejects.toThrow()
  expect(sent).toBe(0)
})
