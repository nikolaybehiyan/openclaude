import {expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {runInNewContext} from 'node:vm'
import type {ToolPermissionContext} from '../../Tool.js'
import type {PermissionBehavior, PermissionRule} from '../../types/permissions.js'
import {WORKFLOW_TOOL_NAME, CODE_REVIEW_WORKFLOW_NAME} from './constants.ts'
import {checkWorkflowPermission, type WorkflowPermissionDecisionHost, type WorkflowPermissionInput} from './permissionDecision.ts'

// Exact method at embedded-JS offset 12572255 in pinned Claude Code 2.1.226.
// Binary SHA256: 013a1cf17df5ff1dcc189d5d6fd3fdd5f097ddc3cd41aa9992e99805574febbe.
// Only this decision method is evaluated; never the binary or user scripts.
const reference = "async checkPermissions(e,t){let r=kn(t),n=e.scriptPath?void 0:e.name,o=(c)=>n?Zye(r,iP,c).get(n):void 0,i=o(\"deny\");if(i)return{behavior:\"deny\",message:`Workflow ${n} blocked by permission rules`,decisionReason:{type:\"rule\",rule:i}};let s=e;if(e.scriptPath){let c=await e2t(e.scriptPath);if(!(\"error\"in c))s={...e,script:c.script}}else if(e.name){let c=await RRn(e.name,Vt());s={...e,script:c?.script}}let a=o(\"ask\");if(a)return{behavior:\"ask\",message:\"Review dynamic workflow before running\",updatedInput:s,decisionReason:{type:\"rule\",rule:a}};let l=o(\"allow\");if(l)return{behavior:\"allow\",updatedInput:s,decisionReason:{type:\"rule\",rule:l}};return{behavior:\"ask\",message:\"Review dynamic workflow before running\",updatedInput:s,...n&&{suggestions:[{type:\"addRules\",rules:[{toolName:iP,ruleContent:n}],behavior:\"allow\",destination:\"localSettings\"}]}}}"
const empty = ():ToolPermissionContext => ({mode:'default',additionalWorkingDirectories:new Map(),
  alwaysAllowRules:{},alwaysDenyRules:{},alwaysAskRules:{}})
const rule = (behavior:PermissionBehavior, name='review'):PermissionRule => ({
  source:'localSettings',ruleBehavior:behavior,ruleValue:{toolName:'Workflow',ruleContent:name}})

function fixture(mask=0) {
  const context=empty(),calls:string[]=[],rules=new Map<PermissionBehavior,ReadonlyMap<string,PermissionRule>>()
  for(const [bit,behavior] of (['deny','ask','allow'] as const).entries())
    rules.set(behavior,new Map(mask&(1<<bit)?[['review',rule(behavior)]]:[]))
  const host:WorkflowPermissionDecisionHost={
    readPermissionContext:()=>{calls.push('context');return context},
    getRules:(actual,tool,behavior)=>{
      expect(actual).toBe(context);expect(tool).toBe('Workflow')
      calls.push(behavior);return rules.get(behavior)!
    },
    readScriptPath:async name=>{calls.push('path:'+name);return {script:'path bytes'}},
    resolveNamed:async name=>{calls.push('name:'+name);return {script:'named bytes'}},
  }
  return {host,context,calls}
}

function original(host:WorkflowPermissionDecisionHost) {
  return runInNewContext('({' + reference + '}).checkPermissions', {
    kn:()=>host.readPermissionContext(),iP:'Workflow',
    Zye:host.getRules,e2t:host.readScriptPath,RRn:host.resolveNamed,Vt:()=>'/workspace',
  }, {timeout:1000,contextCodeGeneration:{strings:false,wasm:false}})
}

test('canonical identities and pinned permission reference match 2.1.226',()=>{
  expect(WORKFLOW_TOOL_NAME).toBe('Workflow')
  expect(CODE_REVIEW_WORKFLOW_NAME).toBe('code-review')
  expect(createHash('sha256').update(reference).digest('hex')).toBe('bbd3bff828dbec117c37e255f1bc9dfaba204740f0e11bb5a3aac4653b8ed83d')
})

test('named, path and inline decisions plus host call ordering match all rule combinations',async()=>{
  const inputs:WorkflowPermissionInput[]=[
    {name:'review',args:{branch:'test'}},{name:'other'}, {script:'inline bytes'},
    {name:'review',script:'supplied bytes'}, {name:'review',scriptPath:'workflow.js'},
    {scriptPath:'workflow.js',resumeFromRunId:'wf_previous'}, {name:''}, {name:'review',scriptPath:''},
  ]
  for(let mask=0;mask<8;mask++)for(const input of inputs) {
    const ours=fixture(mask),pinned=fixture(mask),before=structuredClone(input)
    const actual=await checkWorkflowPermission(input,ours.host)
    const expected=await original(pinned.host)(input,{})
    expect(actual).toEqual(expected)
    expect(ours.calls).toEqual(pinned.calls)
    expect(input).toEqual(before)
    expect('updatedInput' in actual && actual.updatedInput===input).toBe('updatedInput' in expected && expected.updatedInput===input)
  }
})

test('a named deny wins before any filesystem or registry lookup',async()=>{
  const {host,calls}=fixture(7)
  host.resolveNamed=async()=>{throw Error('Must not resolve')}
  expect((await checkWorkflowPermission({name:'review'},host)).behavior).toBe('deny')
  expect(calls).toEqual(['context','deny'])
})

test('path bytes are captured once and never inherit a name allow or suggestion',async()=>{
  const {host}=fixture(4)
  let bytes='approved bytes',reads=0
  host.readScriptPath=async()=>{reads++;return {script:bytes}}
  const result=await checkWorkflowPermission({name:'review',scriptPath:'workflow.js'},host)
  bytes='changed after approval'
  expect(result.behavior).toBe('ask')
  expect('updatedInput' in result && result.updatedInput?.script).toBe('approved bytes')
  expect('suggestions' in result).toBe(false)
  expect(reads).toBe(1)
})

test('lookup failures retain original behavior rather than silently becoming allows',async()=>{
  for(const failure of ['path-error','name-absent','path-throws','name-throws']) {
    const ours=fixture(),pinned=fixture()
    for(const {host} of [ours,pinned]) {
      if(failure==='path-error')host.readScriptPath=async()=>({error:'unreadable'})
      if(failure==='name-absent')host.resolveNamed=async()=>undefined
      if(failure==='path-throws')host.readScriptPath=async()=>{throw Error('read failed')}
      if(failure==='name-throws')host.resolveNamed=async()=>{throw Error('lookup failed')}
    }
    const input=failure.startsWith('path')?{scriptPath:'gone.js'}:{name:'review'}
    const actual=checkWorkflowPermission(input,ours.host),expected=original(pinned.host)(input,{})
    if(failure.endsWith('throws')) {
      const results=await Promise.allSettled([actual,expected])
      expect(results.map(r=>r.status)).toEqual(['rejected','rejected'])
    } else expect(await actual).toEqual(await expected)
  }
})

test('each call reads the current permission owner and named matching is exact',async()=>{
  const {host}=fixture()
  let current=empty()
  host.readPermissionContext=()=>current
  host.getRules=(context,_tool,behavior)=>new Map(
    behavior==='deny'&&context.alwaysDenyRules.session?.length?[['review',rule('deny')]]:[])
  expect((await checkWorkflowPermission({name:'review'},host)).behavior).toBe('ask')
  current={...current,alwaysDenyRules:{session:['Workflow(review)']}}
  expect((await checkWorkflowPermission({name:'review'},host)).behavior).toBe('deny')
  expect((await checkWorkflowPermission({name:'review-extra'},host)).behavior).toBe('ask')
})
