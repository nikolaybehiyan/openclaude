import {expect,test} from 'bun:test'
import {parseDarbCatalog} from './darbCatalog.js'

const model={id:'claude-sonnet-4-6',display_name:'Qwen3.8-Max',type:'model',max_context_tokens:1000000,max_input_tokens:983616,max_output_tokens:131072,
  native_parameters:{version:1,thinking_types:['enabled','disabled'],effort_values:['low','medium','xhigh']}}
const catalog=(row:unknown)=>parseDarbCatalog({configuration_mode:'default',has_more:false,data:[row]})

test('default capacity and native controls are immutable public metadata, not a connection',()=>{
  const result=catalog({...model,api_key:'must-not-retain',base_url:'https://private.invalid'})
  expect(result.mode).toBe('default')
  if(result.mode!=='default')throw Error('wrong mode')
  expect(result.models[0]).toEqual(model)
  expect(Object.isFrozen(result.models[0]?.native_parameters?.effort_values)).toBe(true)
})
test('partial, inconsistent and malformed default facts fail closed',()=>{
  for(const patch of [{max_input_tokens:undefined},{max_context_tokens:0},{max_output_tokens:1.5},{max_input_tokens:1000001},
    {native_parameters:{...model.native_parameters,effort_values:['fake']}},
    {native_parameters:{...model.native_parameters,credential:'hidden'}},
    {connection_id:'icn_'+'a'.repeat(32)}]){
    expect(()=>catalog({...model,...patch})).toThrow()
  }
})
