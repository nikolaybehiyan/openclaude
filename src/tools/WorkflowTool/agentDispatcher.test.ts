import test from 'node:test'
import assert from 'node:assert/strict'
import {createContext,runInContext} from 'node:vm'
import {createWorkflowAgentDispatcher,workflowLocalConcurrency,type WorkflowAgentRequest,type WorkflowProgressEvent} from './agentDispatcher.ts'
import {hardenWorkflowContext,createWorkflowVMBridge} from './vmBoundary.ts'
import {indexWorkflowJournal,workflowInvocationKey,type WorkflowJournalRecord} from './journal.ts'

function setup(extra:Partial<Parameters<typeof createWorkflowAgentDispatcher>[0]>={}) {
  const context=createContext({}, {codeGeneration:{strings:false,wasm:false}})
  hardenWorkflowContext(context)
  const bridge=createWorkflowVMBridge(context),requests:WorkflowAgentRequest[]=[],progress:WorkflowProgressEvent[]=[],records:WorkflowJournalRecord[]=[]
  const hooks=createWorkflowAgentDispatcher({defaultModel:'glm',cpuCount:4,onProgress:e=>progress.push(e),journal:{append:async r=>{records.push(r)}},executeAgent:async req=>{requests.push(req);req.onStarted('a'+req.index);return 'answer'},...extra})
  hooks.bindVMAwait(bridge)
  return {hooks,requests,progress,records,bridge,run:(s:string)=>runInContext(s,context)}
}
test('dispatch snapshots options, retains schema identity and records phases and started/results',async()=>{
  const h=setup(),options=h.run('globalThis.schema={type:"object"};({schema,effort:"xhigh"})')
  h.hooks.phase('Review')
  await h.hooks.agent('first',options)
  await h.hooks.agent('second',h.run('({schema,effort:"high"})'))
  assert.equal(h.requests[0]!.phaseTitle,'Review')
  assert.equal(h.requests[0]!.stallMs,180000)
  assert.equal(h.requests[0]!.options!.schema,h.requests[1]!.options!.schema)
  assert.notEqual(h.requests[0]!.options,options)
  assert.equal(h.progress.filter(e=>e.data.type==='workflow_phase').length,1)
  assert.deepEqual(h.records.map(r=>r.type),['started','result','started','result'])
})
test('journal replays valid empty results only until the first missed chained invocation',async()=>{
  const first=workflowInvocationKey('first',undefined,''),second=workflowInvocationKey('second',undefined,first),third=workflowInvocationKey('third',undefined,second)
  const h=setup({replay:indexWorkflowJournal([{type:'result',key:first,agentId:'old',result:false},{type:'result',key:third,agentId:'old',result:'stale-suffix'}])})
  assert.equal(await h.hooks.agent('first'),false)
  assert.equal(await h.hooks.agent('second'),'answer')
  assert.equal(await h.hooks.agent('third'),'answer')
  assert.equal(h.requests.length,2)
  assert.equal(h.hooks.getAgentCount(),3)
  assert.equal(h.progress.filter(e=>e.data.cached).length,1)
})
test('budget and call cap are shared; explicit remote path remains unavailable in pinned build',async()=>{
  const h=setup({budget:{total:100,getTurnSpent:()=>100}})
  await assert.rejects(h.hooks.agent('blocked'),{name:'WorkflowBudgetExceededError'})
  assert.equal(h.requests.length,0)
  const remote=setup()
  await assert.rejects(remote.hooks.agent('no',remote.run('({isolation:"remote"})')),/not available in this build/)
  assert.equal(remote.requests.length,0)
  const cap=setup({journal:undefined,executeAgent:async()=>''})
  for(let i=0;i<1000;i++)await cap.hooks.agent('bounded')
  await assert.rejects(cap.hooks.agent('too many'),{name:'WorkflowAgentCapError'})
})
test('queued agents recheck shared budget and CPU concurrency stays bounded',async()=>{
  let active=0,maximum=0,spent=0
  const h=setup({budget:{total:10,getTurnSpent:()=>spent},executeAgent:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,5));spent=10;active--;return 'done'}})
  const results=await Promise.allSettled([h.hooks.agent('a'),h.hooks.agent('b'),h.hooks.agent('c')])
  assert.equal(maximum,2)
  assert.equal(results[2]!.status,'rejected')
  assert.deepEqual([1,2,4,8,32].map(workflowLocalConcurrency),[2,2,2,6,16])
})
