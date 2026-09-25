import test from 'node:test'
import assert from 'node:assert/strict'
import {createContext, runInContext} from 'node:vm'
import {hardenWorkflowContext, createWorkflowVMBridge} from './vmBoundary.ts'
import {workflowHostError, wrapWorkflowHostSync, wrapWorkflowHostAsync, createWorkflowTimers} from './hostBoundary.ts'

test('host errors have no host prototypes or callable constructor route', async () => {
  const context = createContext({}, {codeGeneration: {strings: false, wasm: false}})
  hardenWorkflowContext(context)
  const input = runInContext('({get name(){throw 1},message:"safe",get stack(){throw 2}})', context)
  const error = workflowHostError(input)
  assert.equal(Object.getPrototypeOf(error), null)
  assert.equal(Object.getPrototypeOf(error.toString), null)
  assert.equal(Object.isFrozen(error), true)
  assert.equal(error.toString(), 'Error: safe')
  const hostile = runInContext('new Proxy({}, {get(){throw new Proxy({}, {get(){throw 42}})}})', context)
  assert.equal(workflowHostError(hostile).message, '<unprintable thrown value>')
  const sync = wrapWorkflowHostSync(() => {throw input})
  const async = wrapWorkflowHostAsync(async () => {throw input})
  assert.equal(Object.getPrototypeOf(sync), null)
  assert.equal(Object.getPrototypeOf(async), null)
  assert.throws(sync, e => (e as typeof error).message === 'safe' && Object.getPrototypeOf(e) === null)
  await assert.rejects(async(), e => (e as typeof error).message === 'safe' && Object.getPrototypeOf(e) === null)
})

test('timers run in the guest, contain callback errors, and never coerce object delays', async () => {
  const controller = new AbortController(), timers = createWorkflowTimers(controller.signal)
  const context = createContext({setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout}, {codeGeneration:{strings:false,wasm:false}})
  hardenWorkflowContext(context)
  timers.bindVMInvoke(runInContext('(fn => {fn()})', context))
  try {
    const bridge = createWorkflowVMBridge(context)
    const result = await bridge.settle(runInContext(`(async()=>{
      globalThis.coerced=false;
      setTimeout(()=>{throw Error('contained')},0);
      return await new Promise(resolve=>setTimeout(()=>resolve(42),{valueOf(){coerced=true;throw 1}}));
    })()`, context, {timeout:100}))
    assert.equal(result.v, 42)
    assert.equal(runInContext('coerced',context), false)
  } finally { timers.dispose() }
})

test('clear, abort and disposal cancel only this workflow timers', async () => {
  const controller = new AbortController(), timers = createWorkflowTimers(controller.signal)
  let calls = 0
  const id = timers.setTimeout(()=>calls++,10)
  timers.clearTimeout(String(id))
  timers.setTimeout(()=>calls++,10)
  controller.abort()
  assert.equal(timers.setTimeout(()=>calls++,0), 0)
  await new Promise(resolve=>setTimeout(resolve,25))
  assert.equal(calls, 0)
  timers.dispose()
  const normal = createWorkflowTimers()
  normal.setTimeout(()=>calls++,10)
  normal.dispose()
  assert.equal(normal.setTimeout(()=>calls++,0), 0)
  await new Promise(resolve=>setTimeout(resolve,25))
  assert.equal(calls, 0)
})
