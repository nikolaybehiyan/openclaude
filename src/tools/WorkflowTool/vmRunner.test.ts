import test from 'node:test'
import assert from 'node:assert/strict'
import {getEventListeners} from 'node:events'
import {compileWorkflowScript} from './compiler.ts'
import {executeWorkflowVM, type WorkflowHooks} from './vmRunner.ts'
import type {WorkflowVMBridge} from './vmBoundary.ts'

function harness() {
  let bridge: WorkflowVMBridge, count=0
  const calls:unknown[]=[],phases:unknown[]=[]
  const hooks:WorkflowHooks={
    agent: async (prompt,options)=>{calls.push([bridge.sanitize(prompt),bridge.sanitize(options)]);count++;return bridge.clone({answer:42})},
    parallel:async()=>{throw Error('orchestrator intentionally not installed in fixture')},
    pipeline:async()=>{throw Error('orchestrator intentionally not installed in fixture')},
    workflow:async()=>{throw Error('child resolver intentionally not installed in fixture')},
    log:()=>{},phase:title=>phases.push(title),bindVMAwait:value=>{bridge=value},getAgentCount:()=>count,getFailures:()=>[],
  }
  async function run(body:string,options:Parameters<typeof executeWorkflowVM>[2]={}) {
    const compiled=compileWorkflowScript(body)
    assert.equal(compiled.ok,true)
    if (!compiled.ok) throw Error(compiled.error)
    return executeWorkflowVM(compiled.vmScript,hooks,options)
  }
  return {run,calls,phases}
}

test('runs compiled guest with arguments, phases, logging and explicit agent adapter',async()=>{
  const h=harness(),result=await h.run('phase("Review");console.log("args",args);log("start");return await agent(args.prompt,{effort:"xhigh"})',{args:{prompt:'review'}})
  assert.equal(result.error,undefined)
  assert.deepEqual(result.result,{answer:42})
  assert.equal(result.agentCount,1)
  assert.deepEqual(h.phases,['Review'])
  assert.deepEqual(result.logs,['args {"prompt":"review"}','start'])
})

test('top-level function, cycle, bigint and hostile thrown values become bounded results',async()=>{
  for(const code of ['return ()=>42','const a={};a.self=a;return a','return 12n','throw new Proxy({}, {get(){throw 42}})']){
    const r=await harness().run(code)
    assert.equal(r.result,null)
    assert.equal(typeof r.error,'string')
  }
  const r=await harness().run('return {ok:42,get bad(){throw Error("no")},fn(){}}')
  assert.deepEqual(r.result,{ok:42})
})

test('synchronous loop times out and an unresolved async operation responds to abort',async()=>{
  const loop=await harness().run('while(true){}',{syncTimeoutMs:20})
  assert.match(loop.error!,/timed out/)
  const c=new AbortController()
  const pending=harness().run('await new Promise(()=>{})',{signal:c.signal})
  setTimeout(()=>c.abort(),15)
  assert.match((await pending).error!,/Workflow aborted/)
  assert.match((await harness().run('return 42',{signal:c.signal})).error!,/Workflow aborted/)
})

test('budget is read-only and console logging is capped without escaping guest values',async()=>{
  const result=await harness().run('console.warn({get hostile(){throw 42},safe:1});for(let i=0;i<1100;i++)console.log(i);return [budget.total,budget.spent(),budget.remaining()]',{budget:{total:100,getTurnSpent:()=>25}})
  assert.deepEqual(result.result,[100,25,75])
  assert.equal(result.logs.length,1000)
  assert.equal(result.logs[0],'[warn] {"safe":1}')
})

test('setup failure releases the parent abort listener before any guest executes',async()=>{
  const controller=new AbortController(),compiled=compileWorkflowScript('throw Error("guest must not run")')
  assert.equal(compiled.ok,true)
  if(!compiled.ok)throw Error(compiled.error)
  const before=getEventListeners(controller.signal,'abort').length
  const hooks:WorkflowHooks={agent:()=>{},parallel:()=>{},pipeline:()=>{},workflow:()=>{},log:()=>{},phase:()=>{},
    bindVMAwait:()=>{throw Error('setup failed')},getAgentCount:()=>0,getFailures:()=>[]}
  const result=await executeWorkflowVM(compiled.vmScript,hooks,{signal:controller.signal})
  assert.match(result.error!,/setup failed/)
  assert.equal(getEventListeners(controller.signal,'abort').length,before)
})
