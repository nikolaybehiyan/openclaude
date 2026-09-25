import test from 'node:test'
import assert from 'node:assert/strict'
import {createContext,runInContext} from 'node:vm'
import {hardenWorkflowContext,createWorkflowVMBridge} from './vmBoundary.ts'
import {createWorkflowCombinators} from './combinators.ts'

function harness(guard=()=>{}) {
  const context=createContext({}, {codeGeneration:{strings:false,wasm:false}})
  hardenWorkflowContext(context)
  const bridge=createWorkflowVMBridge(context),failures:string[]=[],logs:string[]=[]
  const combinators=createWorkflowCombinators({bridge:()=>bridge,guard,recordFailure:s=>failures.push(s),log:s=>logs.push(s)})
  return {...combinators,bridge,failures,logs,run:(s:string)=>runInContext(s,context,{timeout:100})}
}
test('parallel preserves slot order, contains failures and does not assimilate raw results on host',async()=>{
  const h=harness()
  const result=await h.parallel(h.run('[()=>42,()=>{throw {message:"bad"}},async()=>false,()=>({then(r){r(7)}})]'))
  assert.equal(h.bridge.stringify(result),'[42,null,false,7]')
  assert.deepEqual(h.failures,['parallel[1] failed: bad'])
  assert.deepEqual(h.logs,h.failures)
})
test('pipeline passes previous, original and index and skips only null values',async()=>{
  const h=harness()
  const result=await h.pipeline(h.run('[1,2,null,0,false]'),h.run('(v,original,index)=>v===2?null:[v,original,index]'),h.run('v=>v'))
  assert.equal(h.bridge.stringify(result),'[[1,1,0],null,null,[0,0,3],[false,false,4]]')
})
test('shared budget failures are summarized while other failed branches retain diagnostics',async()=>{
  const h=harness()
  const result=await h.parallel(h.run('[()=>{throw {name:"WorkflowBudgetExceededError",message:"limit"}},()=>3]'))
  assert.equal(h.bridge.stringify(result),'[null,3]')
  assert.deepEqual(h.failures,['parallel: 1 slot dropped — token budget exceeded'])
  assert.deepEqual(h.logs,[])
})
test('rejects promises instead of functions, invalid stages and oversized guest arrays',async()=>{
  const h=harness()
  await assert.rejects(h.parallel(h.run('[Promise.resolve(1)]')),/not promises/)
  await assert.rejects(h.pipeline(h.run('[1]'),42),/stages must be functions/)
  await assert.rejects(h.parallel({}),/expects an array/)
  await assert.rejects(h.parallel(h.run('new Proxy([], {get(t,k){return k==="length"?4097:undefined}})')),/maximum of 4096/)
})
test('empty inputs keep upstream no-guard behavior, non-empty requests use caller guard',async()=>{
  let guards=0
  const h=harness(()=>{guards++;throw Error('guard')})
  assert.equal(h.bridge.stringify(await h.parallel(h.run('[]'))),'[]')
  assert.equal(h.bridge.stringify(await h.pipeline(h.run('[]'))),'[]')
  assert.equal(guards,0)
  await assert.rejects(h.parallel(h.run('[()=>1]')),/guard/)
  assert.equal(guards,1)
})
