import test from 'node:test'
import assert from 'node:assert/strict'
import {createChildWorkflowResolver} from './childWorkflow.ts'
import {createWorkflowAgentDispatcher} from './agentDispatcher.ts'
import {WorkflowRegistry,type WorkflowDefinition} from './registry.ts'
import {compileWorkflowScript} from './compiler.ts'
import {executeWorkflowVM} from './vmRunner.ts'
import type {WorkflowVMBridge} from './vmBoundary.ts'

function fixture(child:string) {
  const script=`export const meta={name:'child',description:'child'};${child}`
  const builtins:WorkflowDefinition[]=[{source:'built-in',name:'child',description:'child',script}]
  const registry=new WorkflowRegistry({builtins,nameOnly:()=>true})
  const events:any[]=[],calls:any[]=[]
  let parentBridge:WorkflowVMBridge,childResolver:ReturnType<typeof createChildWorkflowResolver>
  const hooks=createWorkflowAgentDispatcher({defaultModel:'glm-5.3',onProgress:event=>events.push(event),
    executeAgent:async request=>{calls.push(request);return request.prompt},childWorkflow:(...args)=>childResolver(...args)})
  const bind=hooks.bindVMAwait
  hooks.bindVMAwait=bridge=>{parentBridge=bridge;bind(bridge)}
  childResolver=createChildWorkflowResolver({registry,cwd:()=>'/fixture',parentBridge:()=>parentBridge,hooks})
  const run=async(body:string)=>{
    const compiled=compileWorkflowScript(body)
    if(!compiled.ok)throw Error(compiled.error)
    return executeWorkflowVM(compiled.vmScript,hooks)
  }
  return {run,calls,events,hooks}
}
test('child shares parent agents/accounting while keeping its realm and phase isolated',async()=>{
  const f=fixture('globalThis.childOnly=1;phase("ignored");log("one");console.log("two");return await parallel([()=>agent(args.a),()=>agent(args.b)])')
  const result=await f.run('const child=await workflow("child",{a:"A",b:"B"});return [child,typeof childOnly,await agent("parent")]')
  assert.equal(result.error,undefined)
  assert.deepEqual(result.result,[['A','B'],'undefined','parent'])
  assert.equal(result.agentCount,3)
  assert.deepEqual(f.calls.map(c=>c.phaseTitle),['▸ child','▸ child',undefined])
  const logs=f.events.filter(e=>e.data.type==='workflow_log').map(e=>e.data.message)
  assert.equal(logs.filter(x=>x==='[child] one').length,1)
  assert.equal(logs.filter(x=>x==='[child] two').length,1)
})
test('repeated child calls get distinct phases; recursive nesting is denied and recorded',async()=>{
  const repeated=fixture('return 42')
  assert.deepEqual((await repeated.run('return [await workflow("child"),await workflow("child")]')).result,[42,42])
  assert.deepEqual(repeated.events.filter(e=>e.data.type==='workflow_phase').map(e=>e.data.title),['▸ child','▸ child #2'])
  const recursive=fixture('return await workflow("child")')
  assert.match((await recursive.run('return await workflow("child")')).error!,/nesting is limited to one level/)
  assert.equal(recursive.hooks.getFailures().length,1)
})
test('named-only policy cannot be bypassed by nested path/inline and invalid selectors',async()=>{
  const f=fixture('return args')
  for(const call of ['workflow({scriptPath:"/fixture/unapproved.js"})','workflow({script:"return 42"})','workflow(42)']) {
    const result=await f.run(`return await ${call}`)
    assert.equal(typeof result.error,'string')
    assert.equal(f.calls.length,0)
  }
  const result=await f.run('return await workflow("child",{get bad(){throw Error("guest")},ok:42})')
  assert.deepEqual(result.result,{ok:42})
})
