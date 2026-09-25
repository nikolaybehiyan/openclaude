import test from 'node:test'
import assert from 'node:assert/strict'
import {runWorkflowAgentAttempt, type WorkflowAgentMessage, type WorkflowAttemptOptions} from './agentAttempt.ts'

const assistant = (content: NonNullable<WorkflowAgentMessage['message']>['content'], fields = {}): WorkflowAgentMessage => ({type:'assistant',message:{content,usage:{input_tokens:30,output_tokens:12},model:'glm-5.3',stop_reason:'end_turn',...fields}})
function fixture(extra: Partial<WorkflowAttemptOptions> = {}) {
  const events:unknown[] = [], controllers:(AbortController|null)[] = [],models:string[] = []
  const options:WorkflowAttemptOptions = {stallMs:500,structured:false,maxStructuredOutputRetries:5,autoMode:true,
    makeStream:async function*(){yield assistant([{type:'text',text:'42'}])},
    onController:controller=>controllers.push(controller),onProgress:(state,fields)=>events.push({state,...fields}),
    countTokens:usage=>Number(usage?.input_tokens??0)+Number(usage?.output_tokens??0),summarizeToolInput:()=>undefined,onModel:model=>models.push(model),...extra}
  return {run:()=>runWorkflowAgentAttempt(options),events,controllers,models}
}
function untilAbort(signal:AbortSignal):Promise<never> {
  return new Promise((_resolve,reject)=>{
    const done = ()=>reject(Error('runAgent aborted'))
    if (signal.aborted) done();else signal.addEventListener('abort',done,{once:true})
  })
}
test('consumes assistant, tool, structured and API streams without losing zero/false results',async()=>{
  const plain=fixture(),r=await plain.run()
  assert.equal(r.text,'42');assert.equal(r.tokens,42);assert.equal(r.outputTokens,12)
  assert.deepEqual(plain.models,['glm-5.3']);assert.equal(plain.controllers.at(-1),null)
  for (const value of [0,false,'',null,{answer:42}]) {
    const f=fixture({structured:true,makeStream:async function*(){
      yield assistant([{type:'tool_use',id:'s',name:'StructuredOutput',input:{answer:42}}])
      yield {type:'attachment',attachment:{type:'structured_output',data:value}}
      yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'s'}]}}
    }})
    const result=await f.run();assert.deepEqual(result.structured,value);assert.equal(result.toolCalls,1)
  }
  const f=fixture({makeStream:async function*(){yield {...assistant([{type:'text',text:'503 provider unavailable'}]),isApiErrorMessage:true}}})
  assert.equal((await f.run()).apiError,'503 provider unavailable');assert.deepEqual(f.models,[])
})
test('structured retry cap counts matching failed tool results once, not unrelated failures',async()=>{
  const f=fixture({structured:true,maxStructuredOutputRetries:2,makeStream:async function*(){
    yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'foreign',is_error:true}]}}
    for (let i=0;i<2;i++) {
      yield assistant([{type:'tool_use',id:`s${i}`,name:'StructuredOutput',input:{bad:true}}])
      yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:`s${i}`,is_error:true},{type:'tool_result',tool_use_id:`s${i}`,is_error:true}]}}
    }
    assert.fail('cap should stop before another query')
  }})
  await assert.rejects(f.run(),/retry cap \(2\).*2 failed calls/)
  assert.equal(f.controllers.at(-1),null)
})
test('stalls and manual retry/skip remain different outcomes; parent abort is fatal',async()=>{
  const stalled=fixture({stallMs:10,makeStream:async function*(controller){await untilAbort(controller.signal)}})
  assert.equal((await stalled.run()).stalledReason,'stalled')
  for (const reason of ['user-retry','user-skip']) {
    const f=fixture({makeStream:async function*(controller){controller.abort(new DOMException(reason,'AbortError'));await untilAbort(controller.signal)}})
    const result=await f.run()
    assert.equal(result.stalled,reason==='user-retry');assert.equal(result.skipped,reason==='user-skip')
  }
  const parent=new AbortController()
  const f=fixture({signal:parent.signal,makeStream:async function*(){parent.abort();throw Error('child stopped')}})
  await assert.rejects(f.run(),/child stopped/)
  assert.equal(f.controllers[0]!.signal.aborted,true)
  assert.equal(f.controllers.at(-1),null)
})
test('stream liveness resets stall clock; active tools suspend it until removal',async()=>{
  const f=fixture({stallMs:30,makeStream:async function*(controller,tick){
    for(let i=0;i<3;i++){await new Promise(resolve=>setTimeout(resolve,15));tick();assert.equal(controller.signal.aborted,false)}
    yield assistant([{type:'tool_use',id:'slow',name:'Read',input:{file_path:'/fixture'}}])
    await new Promise(resolve=>setTimeout(resolve,50));assert.equal(controller.signal.aborted,false)
    yield {type:'set_in_progress_tool_use_ids',op:{action:'remove',ids:['slow']}}
    await untilAbort(controller.signal)
  }})
  const r=await f.run();assert.equal(r.stalledReason,'stalled');assert.equal(r.toolCalls,1)
})
test('valid structured result survives a later stall but manual retry does not cache it',async()=>{
  for (const reason of ['stalled','user-retry']) {
    const f=fixture({structured:true,makeStream:async function*(controller){
      yield {type:'attachment',attachment:{type:'structured_output',data:false}}
      controller.abort(reason);await untilAbort(controller.signal)
    }})
    const r=await f.run();assert.equal(r.structured,reason==='stalled'?false:undefined)
    assert.equal(r.stalled,reason==='user-retry')
  }
})
