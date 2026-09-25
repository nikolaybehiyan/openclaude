import {expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {runInNewContext} from 'node:vm'
import {parse} from 'acorn'
import * as walk from 'acorn-walk'
import {parseWorkflowScript} from './scriptParser.ts'
import type {WorkflowInput} from './registry.ts'
import {hasWorkflowNondeterminism, validateWorkflowInput, type WorkflowValidationHost} from './validation.ts'

// Exact methods from embedded JS in Claude Code 2.1.226. Binary SHA256:
// 013a1cf17df5ff1dcc189d5d6fd3fdd5f097ddc3cd41aa9992e99805574febbe.
// Only these methods run with fixture hosts; no binary or workflow is executed.
const reference = 'async validateInput(e,t){if(GDe(t.abortController.signal))return Gjp;if(Vpr())return{result:!1,message:"Dynamic workflows are disabled by managed settings (`disableWorkflows`).",errorCode:5};if(!Ck())return{result:!1,message:\'Dynamic workflows are not enabled for this session (org policy, launch gate, or the "Dynamic workflows" setting in /config).\',errorCode:6};if(IGt()){let o=[e.script&&"script",e.scriptPath&&"scriptPath",e.resumeFromRunId&&"resumeFromRunId",e.remote&&"remote"].filter((i)=>Boolean(i));if(o.length>0)return{result:!1,message:`This session restricts the Workflow tool to named workflows (${$Np} is set). Not allowed here: ${o.join(", ")}. Invoke as {name, args} only.`,errorCode:8}}let r=await Wjp(e);if(GDe(t.abortController.signal))return Gjp;if("error"in r){if(e.name&&!e.scriptPath)fe("workflow_resolve","not_found");return{result:!1,message:r.error,errorCode:1}}if(e.name&&!e.scriptPath)Te("workflow_resolve");let n=pP(r.script);if("error"in n)return{result:!1,message:`Invalid workflow script: ${n.error}`,errorCode:2};if(e.script&&fZo(n.scriptBody))return{result:!1,message:"Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.",errorCode:4};if(e.resumeFromRunId){for(let[o,i]of Object.entries(t.taskRegistry.all()))if(i.type==="local_workflow"&&i.status==="running"&&i.workflowRunId===e.resumeFromRunId)return{result:!1,message:`Workflow ${e.resumeFromRunId} is still running (task ${o}). Stop it first with ${OF}({taskId: "${o}"}) before resuming.`,errorCode:3}}return{result:!0}}'
const nondeterminism = 'function fZo(e){let{parse:t}=bHo(),r=Rha(),n=!1;try{let o=t(e,{ecmaVersion:"latest",sourceType:"module",allowAwaitOutsideFunction:!0,allowReturnOutsideFunction:!0});r.simple(o,{MemberExpression(i){if(i.computed||i.object.type!=="Identifier"||i.property.type!=="Identifier")return;let s=i.object.name,a=i.property.name;if(s==="Date"&&a==="now"||s==="Math"&&a==="random")n=!0},NewExpression(i){if(i.callee.type==="Identifier"&&i.callee.name==="Date"&&i.arguments.length===0)n=!0}})}catch{return!1}return n}'
const good = "export const meta={name:'review',description:'Review'};\nreturn 42"
const nondeterministic = good.replace('return 42','return Date.now()')
const originalNondeterminism = runInNewContext('('+nondeterminism+')', {bHo:()=>({parse}),Rha:()=>walk},
  {timeout:1000,contextCodeGeneration:{strings:false,wasm:false}})

function fixture(mask=0) {
  const calls:string[]=[]
  let reads=0
  const host:WorkflowValidationHost={
    isRetracted:()=>{calls.push('retracted');return Boolean(mask&1) || Boolean(mask&16)&&++reads===2},
    isDisabledByManagedSettings:()=>{calls.push('managed');return Boolean(mask&2)},
    isEnabled:()=>{calls.push('enabled');return !(mask&4)},
    isNameOnly:()=>{calls.push('name-only');return Boolean(mask&8)},
    resolveInput:async input=>{calls.push('resolve');return input.name==='missing'?{error:'Not found'}:
      {script:input.script ?? (input.name==='invalid'?'invalid syntax':input.name==='clock'?nondeterministic:good)}},
    recordNamedResolution:found=>calls.push('named:'+found),
    readTasks:()=>{calls.push('tasks');return {
      other:{type:'local_workflow',status:'running',workflowRunId:'wf_other'},
      same:{type:'local_workflow',status:'running',workflowRunId:'wf_running'},
      paused:{type:'local_workflow',status:'paused',workflowRunId:'wf_paused'},
      agent:{type:'local_agent',status:'running',workflowRunId:'wf_agent'},
    }},
  }
  return {host,calls}
}

function original(host:WorkflowValidationHost) {
  return runInNewContext('({'+reference+'}).validateInput', {
    GDe:host.isRetracted,Gjp:{result:false,errorCode:7,message:'Tool dispatch was retracted by a server fallback; the input may be truncated.'},
    Vpr:host.isDisabledByManagedSettings,Ck:host.isEnabled,IGt:host.isNameOnly,$Np:'CLAUDE_WORKFLOW_NAME_ONLY',
    Wjp:host.resolveInput,pP:parseWorkflowScript,fZo:originalNondeterminism,OF:'TaskStop',
    fe:()=>host.recordNamedResolution(false),Te:()=>host.recordNamedResolution(true),
  }, {timeout:1000,contextCodeGeneration:{strings:false,wasm:false}})
}
async function compare(input:WorkflowInput,mask=0) {
  const ours=fixture(mask),pinned=fixture(mask),before=structuredClone(input)
  const actual=await validateWorkflowInput(input,ours.host)
  const expected=await original(pinned.host)(input,{abortController:{signal:{}},taskRegistry:{all:pinned.host.readTasks}})
  expect(actual).toEqual(expected)
  expect(ours.calls).toEqual(pinned.calls)
  expect(input).toEqual(before)
  return actual
}

test('pinned public validation method is unchanged',()=>{
  expect(createHash('sha256').update(reference).digest('hex')).toBe('e66581e31ce4e28d659f74d227f1540c397902a52b184fc644693f6c12c20d4b')
})
test('gates, retraction and name-only truthiness match all combinations and ordering',async()=>{
  const inputs:WorkflowInput[]=[{}, {name:'review'}, {script:good}, {name:'review',script:''},
    {name:'review',scriptPath:'file.js'}, {name:'review',remote:true}, {name:'review',remote:false},
    {name:'review',resumeFromRunId:'wf_running'}, {name:'missing'}, {name:'invalid'},
    {name:'clock'}, {script:nondeterministic}, {script:'invalid syntax'},
    {scriptPath:'file.js',resumeFromRunId:'wf_paused'}, {name:'review',resumeFromRunId:'wf_agent'},
    {name:'review',scriptPath:'',resumeFromRunId:'',remote:false}]
  for(let mask=0;mask<32;mask++)for(const input of inputs)await compare(input,mask)
})
test('syntax, resolution, inline nondeterminism and active-run failures keep distinct codes',async()=>{
  for(const [input,code] of [
    [{name:'missing'},1],[{name:'invalid'},2],[{script:nondeterministic},4],
    [{name:'review',resumeFromRunId:'wf_running'},3],
  ] as const)expect(await compare(input)).toMatchObject({result:false,errorCode:code})
  expect(await compare({name:'clock'})).toEqual({result:true})
  expect(await compare({name:'review',resumeFromRunId:'wf_paused'})).toEqual({result:true})
})
test('server fallback while awaiting resolution prevents parsing, telemetry and resume checks',async()=>{
  expect(await compare({name:'invalid',resumeFromRunId:'wf_running'},16)).toMatchObject({errorCode:7})
})
test('the AST detector matches pinned syntax, without evaluating the script',()=>{
  const examples=[['Date.now()',true],['Math.random',true],['new Date()',true],
    ['new Date(0)',false],['Date["now"]()',false],['globalThis.Date.now()',false],
    ['"Math.random()"',false],['// new Date()\nreturn 42',false],['Date?.now()',true],
    ['const Date={now(){return 1}}; Date.now()',true],['return (',false],
    ['throw Error("must not execute")',false],['return await agent("review")',false]] as const
  for(const [script,expected] of examples) {
    expect(hasWorkflowNondeterminism(script)).toBe(expected)
    expect(hasWorkflowNondeterminism(script)).toBe(originalNondeterminism(script))
  }
})
test('resolver exceptions propagate and no task is created or modified by validation',async()=>{
  const {host,calls}=fixture();host.resolveInput=async()=>{throw Error('owner failure')}
  await expect(validateWorkflowInput({name:'review'},host)).rejects.toThrow('owner failure')
  expect(calls).toEqual(['retracted','managed','enabled','name-only'])
})
