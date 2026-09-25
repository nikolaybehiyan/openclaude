import type {WorkflowVMBridge, WorkflowVMFunction} from './vmBoundary.ts'
import {workflowHostError} from './hostBoundary.ts'

// 2.1.226 ZNp parallel()/pipeline(). The agent dispatcher supplies the same
// call/token guards used by agent(), not a separate allowance per branch.
export function createWorkflowCombinators(options: {
  bridge: () => WorkflowVMBridge
  signal?: AbortSignal
  guard: () => void
  recordFailure: (message: string) => void
  log: (message: string) => void
}) {
  const yieldTurn = () => new Promise<void>(resolve=>setTimeout(resolve,0))
  const stopped = () => new Promise<never>(()=>{})
  function collect(kind: 'parallel'|'pipeline', values: PromiseSettledResult<{v:unknown}>[]) {
    let exceeded = 0
    const results = values.map((value,index) => {
      if (value.status === 'fulfilled') return value.value.v
      const error = workflowHostError(value.reason)
      if (error.name === 'WorkflowBudgetExceededError') {exceeded++;return null}
      const message = `${kind}[${index}] failed: ${error.message}`
      options.recordFailure(message);options.log(message)
      return null
    })
    if (exceeded) options.recordFailure(`${kind}: ${exceeded} ${exceeded === 1 ? 'slot' : 'slots'} dropped — token budget exceeded`)
    return options.bridge().clone(results)
  }
  async function parallel(input: unknown) {
    if (options.signal?.aborted) return stopped()
    await yieldTurn()
    if (!Array.isArray(input)) throw TypeError('parallel() expects an array of functions')
    const bridge=options.bridge(), functions=bridge.snapshot(input)
    if (!functions.length) return bridge.clone([])
    options.guard()
    for (const fn of functions) if (typeof fn !== 'function') throw TypeError('parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)')
    const results=await Promise.allSettled(functions.map(fn=>{
      try {return bridge.settle(bridge.call(fn as WorkflowVMFunction))}
      catch(error) {return Promise.reject(error)}
    }))
    return collect('parallel',results)
  }
  async function pipeline(input: unknown, ...stages: unknown[]) {
    if (options.signal?.aborted) return stopped()
    await yieldTurn()
    if (!Array.isArray(input)) throw TypeError('pipeline() expects an array as the first argument')
    const bridge=options.bridge(), items=bridge.snapshot(input)
    if (!items.length) return bridge.clone([])
    options.guard()
    for (const fn of stages) if (typeof fn !== 'function') throw TypeError('pipeline() stages must be functions: pipeline(items, item => ..., result => ...)')
    const results=await Promise.allSettled(items.map(async (item,index)=>{
      let boxed=await bridge.settle(item)
      for (const stage of stages) {
        if (boxed.v === null) break
        boxed=await bridge.settle(bridge.call(stage as WorkflowVMFunction,boxed.v,item,index))
      }
      return boxed
    }))
    return collect('pipeline',results)
  }
  return {parallel,pipeline}
}
