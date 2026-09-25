import test from 'node:test'
import assert from 'node:assert/strict'
import {finishWorkflowAgent} from './agentExecution.ts'
import type {WorkflowAttemptResult} from './agentAttempt.ts'

const output = (overrides:Partial<WorkflowAttemptResult>={}):WorkflowAttemptResult => ({structured:undefined,text:'done',tokens:10,toolCalls:2,stalled:false,skipped:false,durationMs:10,stopReason:'end_turn',outputTokens:10,structuredOutputAttempts:0,lastStructuredOutputInput:undefined,...overrides})
function harness(results: WorkflowAttemptResult[], extra:Partial<Parameters<typeof finishWorkflowAgent>[0]>={}) {
  const attempts:unknown[][]=[],sleeps:number[]=[],logs:string[]=[],failures:string[]=[],handoffs:number[]=[]
  const options:Parameters<typeof finishWorkflowAgent>[0]={label:'Review',stallMs:100,structured:false,
    attempt:async(...args)=>{attempts.push(args);return {...results.shift()!}},sleep:async ms=>{sleeps.push(ms)},log:m=>logs.push(m),recordFailure:m=>failures.push(m),
    classifyHandoff:async(_r,count)=>{handoffs.push(count);return null},...extra}
  return {run:()=>finishWorkflowAgent(options),attempts,sleeps,logs,failures,handoffs}
}
test('initial attempt plus five retries, preserving reason, tokens and tool counts',async()=>{
  const h=harness([...Array.from({length:5},()=>output({stalled:true,stalledReason:'user-retry'})),output()])
  assert.equal(await h.run(),'done');assert.equal(h.attempts.length,6)
  assert.deepEqual(h.attempts[5],['Review (retry 5)',6,'user-retry',{tokens:50,toolCalls:10,durationMs:50}])
  assert.deepEqual(h.handoffs,[12])
  const failure=harness(Array.from({length:6},()=>output({stalled:true,stalledReason:'stalled'})))
  await assert.rejects(failure.run(),/stalled on all 6 attempts/)
})
test('degraded throttled result retries once after45s, not another stall retry loop',async()=>{
  const h=harness([output({stopReason:undefined,durationMs:60}),output({stalled:true})])
  await assert.rejects(h.run(),/stalled on all 1 attempts/)
  assert.deepEqual(h.sleeps,[45000]);assert.equal(h.attempts.length,2)
})
test('API errors and user-skip are null; missing required structured output rejects',async()=>{
  const api=harness([output({apiError:'503'})]);assert.equal(await api.run(),null)
  assert.deepEqual(api.failures,['[Review] failed: 503']);assert.deepEqual(api.handoffs,[])
  const skipped=harness([output({skipped:true})]);assert.equal(await skipped.run(),null);assert.equal(skipped.attempts.length,1)
  await assert.rejects(harness([output()],{structured:true}).run(),/without calling StructuredOutput/)
  for(const value of [null,false,0,''])assert.equal(await harness([output({structured:value})],{structured:true}).run(),value)
})
test('handoff safety finding is visible for text and recorded for structured outputs',async()=>{
  const text=harness([output()],{classifyHandoff:async()=> 'Safety finding'})
  assert.equal(await text.run(),'Safety finding\n\ndone')
  const json=harness([output({structured:{ok:true}})],{structured:true,classifyHandoff:async()=> 'Safety finding'})
  assert.deepEqual(await json.run(),{ok:true});assert.deepEqual(json.failures,['[Review] Safety finding'])
})
test('cancel during backoff or handoff never launches retry or returns success',async()=>{
  const c=new AbortController(),h=harness([output({stopReason:undefined,durationMs:60})],{signal:c.signal,sleep:async()=>{c.abort()}})
  await assert.rejects(h.run(),/Workflow aborted/);assert.equal(h.attempts.length,1)
  const d=new AbortController(),other=harness([output()],{signal:d.signal,classifyHandoff:async()=>{d.abort();return null}})
  await assert.rejects(other.run(),/Workflow aborted/)
})
