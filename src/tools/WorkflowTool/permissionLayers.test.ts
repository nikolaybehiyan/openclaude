import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {runInNewContext} from 'node:vm'
import type {ToolPermissionContext} from '../../Tool.js'
import {readWorkflowPermissionContext,type WorkflowPermissionLayer} from './permissionLayers.ts'

// Exact pure functions read from the pinned 2.1.226 binary, never the executable
// or a Workflow program. The input binary's SHA256 is
// 013a1cf17df5ff1dcc189d5d6fd3fdd5f097ddc3cd41aa9992e99805574febbe.
// Embedded JS starts at byte245797944; function offsets are relative to it.
const references=[
  {offset:4377419,sha256:'abd5a1e763225277481d4f762d5b5909f3829600f112485caedce2e9e995c0c6',source:'function $xs(e,t){if(t.length===0)return e;return{...e,alwaysAllowRules:{...e.alwaysAllowRules,command:ko([...e.alwaysAllowRules.command||[],...t])}}}'},
  {offset:4377569,sha256:'a85909f3be88a28715e6770f3b34f9de795a7ee408b86796493deb4461ca2f4b',source:'function Fxs(e,t){if(t.length===0)return e;return{...e,alwaysDenyRules:{...e.alwaysDenyRules,command:ko([...e.alwaysDenyRules.command||[],...t])}}}'},
  {offset:4379163,sha256:'466809ba6be3a23047be4abacf07bffa0819c0de7a6fa13f412a90972fd29717',source:'function kn(e){let t=e.getAppState().toolPermissionContext,r=e.permissionLayers;if(!r)return t;let n=r.findLast((o)=>o.kind==="working_directory");for(let o of r)switch(o.kind){case"allowed_tools":t=$xs(t,[...o.allowedTools]);break;case"disallowed_tools":t=Fxs(t,[...o.disallowedTools]);break;case"avoid_prompts":if(!t.shouldAvoidPermissionPrompts)t={...t,shouldAvoidPermissionPrompts:!0};break;case"permission_mode":{if(o.mode==="bypassPermissions"&&(iN()||!t.isBypassPermissionsModeAvailable))break;t={...t,mode:o.mode};break}case"working_directory":if(o===n&&!t.additionalWorkingDirectories.has(o.directory))t={...t,additionalWorkingDirectories:new Map([...t.additionalWorkingDirectories,[o.directory,{path:o.directory,source:"session"}]])};break;case"effort":case"model":case"max_thinking_tokens":case"flag_settings":break}return t}'},
]
function fixture():ToolPermissionContext {
  return {mode:'default',isBypassPermissionsModeAvailable:true,
    alwaysAllowRules:{cliArg:['Read'],command:['Glob'],userSettings:['Bash(git status)']},
    alwaysDenyRules:{policySettings:['Bash(rm *)'],command:['Agent(forbidden)']},
    alwaysAskRules:{session:['Bash(git push *)']},
    additionalWorkingDirectories:new Map([['/approved',{path:'/approved',source:'session'}]])}
}
const plain=(value:ToolPermissionContext)=>({...value,additionalWorkingDirectories:[...value.additionalWorkingDirectories]})
const policy={isBypassBlocked:()=>false}

test('pinned pure reference functions retain their verified source hashes',()=>{
  for(const reference of references)expect(createHash('sha256').update(reference.source).digest('hex')).toBe(reference.sha256)
})

test('invocation grants preserve policy deny/ask rules and never mutate parent state',()=>{
  const context=fixture(),before=structuredClone(plain(context))
  const owner={getAppState:()=>({toolPermissionContext:context}),permissionLayers:[
    {kind:'allowed_tools',allowedTools:['Glob','Read','Read']},
    {kind:'disallowed_tools',disallowedTools:['Write','Write']},
    {kind:'avoid_prompts'},
  ] as WorkflowPermissionLayer[]}
  const actual=readWorkflowPermissionContext(owner,policy)
  expect(actual.alwaysAllowRules.command).toEqual(['Glob','Read'])
  expect(actual.alwaysAllowRules.cliArg).toEqual(['Read'])
  expect(actual.alwaysDenyRules.command).toEqual(['Agent(forbidden)','Write'])
  expect(actual.alwaysDenyRules.policySettings).toEqual(['Bash(rm *)'])
  expect(actual.alwaysAskRules).toBe(context.alwaysAskRules)
  expect(actual.shouldAvoidPermissionPrompts).toBe(true)
  expect(plain(context)).toEqual(before)
})

test('only the last invocation directory is layered, preserving existing parent directories',()=>{
  const context=fixture()
  const owner={getAppState:()=>({toolPermissionContext:context}),permissionLayers:[
    {kind:'working_directory',directory:'/outer'},
    {kind:'working_directory',directory:'/inner'},
  ] as WorkflowPermissionLayer[]}
  expect([...readWorkflowPermissionContext(owner,policy).additionalWorkingDirectories.keys()]).toEqual(['/approved','/inner'])
  owner.permissionLayers=[{kind:'working_directory',directory:'/approved'}]
  expect(readWorkflowPermissionContext(owner,policy)).toBe(context)
})

test('fresh parent revocation and live bypass killswitch are observed on every read',()=>{
  let context=fixture(),blocked=false
  const owner={getAppState:()=>({toolPermissionContext:context}),permissionLayers:[{kind:'permission_mode',mode:'bypassPermissions'}] as WorkflowPermissionLayer[]}
  const live={isBypassBlocked:()=>blocked}
  expect(readWorkflowPermissionContext(owner,live).mode).toBe('bypassPermissions')
  blocked=true
  expect(readWorkflowPermissionContext(owner,live).mode).toBe('default')
  blocked=false
  context={...context,mode:'plan',isBypassPermissionsModeAvailable:false,alwaysDenyRules:{policySettings:['Read']}}
  const actual=readWorkflowPermissionContext(owner,live)
  expect(actual.mode).toBe('plan')
  expect(actual.alwaysDenyRules.policySettings).toEqual(['Read'])
})

test('absent, empty and unrelated layers retain parent reference',()=>{
  const context=fixture(),getAppState=()=>({toolPermissionContext:context})
  for(const permissionLayers of [undefined,[],[{kind:'allowed_tools',allowedTools:[]},{kind:'disallowed_tools',disallowedTools:[]}],
    [{kind:'effort'},{kind:'model'},{kind:'max_thinking_tokens'},{kind:'flag_settings'}]] as (WorkflowPermissionLayer[]|undefined)[])
    expect(readWorkflowPermissionContext({getAppState,permissionLayers},policy)).toBe(context)
})

test('ordered layer combinations match the pinned 226 functions, including reference identity',()=>{
  let blocked=false
  const reference=runInNewContext(references.map(row=>row.source).join('\n')+
    '\nkn',
    {ko:(items:string[])=>[...new Set(items)],iN:()=>blocked},
    {timeout:1000,contextCodeGeneration:{strings:false,wasm:false}})
  const choices:WorkflowPermissionLayer[]=[
    {kind:'allowed_tools',allowedTools:['Read','Glob']},{kind:'disallowed_tools',disallowedTools:['Read']},
    {kind:'avoid_prompts'},{kind:'permission_mode',mode:'bypassPermissions'},
    {kind:'permission_mode',mode:'plan'},{kind:'working_directory',directory:'/first'},
    {kind:'working_directory',directory:'/last'},{kind:'model'},
  ]
  for(let first=0;first<choices.length;first++)for(let second=0;second<choices.length;second++)for(const available of [false,true])for(const denyBypass of [false,true]) {
    blocked=denyBypass
    const context={...fixture(),isBypassPermissionsModeAvailable:available}
    const owner={getAppState:()=>({toolPermissionContext:context}),permissionLayers:[choices[first]!,choices[second]!]}
    const before=structuredClone(plain(context)),expected=reference(owner),actual=readWorkflowPermissionContext(owner,{isBypassBlocked:()=>blocked})
    expect(plain(actual)).toEqual(plain(expected))
    expect(actual===context).toBe(expected===context)
    expect(plain(context)).toEqual(before)
  }
})
