import {compileWorkflowScript} from './compiler.ts'
import {WorkflowRegistry} from './registry.ts'
import {executeWorkflowVM, type WorkflowBudget, type WorkflowHooks} from './vmRunner.ts'
import type {WorkflowVMBridge, WorkflowVMFunction} from './vmBoundary.ts'

// FNp: one nesting level, same dispatcher/accounting/permissions and separate
// hardened realm. Parent hooks must never be rebound to the child VM.
export function createChildWorkflowResolver(options:{
  registry:WorkflowRegistry
  cwd:()=>string
  parentBridge:()=>WorkflowVMBridge
  hooks:WorkflowHooks & {resolvePhase:(title:string,kind?:string)=>number;recordFailure:(message:string)=>void}
  signal?:AbortSignal
  budget?:WorkflowBudget
}):WorkflowVMFunction {
  const counts=new Map<string,number>()
  return async(rawSelector:unknown,rawArgs?:unknown)=>{
    if(options.signal?.aborted)return new Promise<never>(()=>{})
    const selector=structuredClone(options.parentBridge().sanitize(rawSelector))
    const input=typeof selector==='string'?{name:selector}:selector && typeof selector==='object' &&
      'scriptPath' in selector && typeof selector.scriptPath==='string'?{scriptPath:selector.scriptPath}:undefined
    if(!input)throw TypeError('workflow() expects a workflow name (string) or {scriptPath: string}')
    const resolved=await options.registry.resolve(input,options.cwd())
    const compiled=compileWorkflowScript(resolved.scriptBody)
    if(!compiled.ok)throw Error(`workflow('${resolved.meta.name}'): ${compiled.error}`)
    const name=resolved.meta.name,call=(counts.get(name)??0)+1
    counts.set(name,call)
    const phase=`▸ ${name}${call>1?` #${call}`:''}`
    options.hooks.resolvePhase(phase,'child')
    options.hooks.log(`▸ running dynamic workflow ${name}`)
    let childBridge:WorkflowVMBridge
    const schemas=new WeakMap<object,unknown>()
    const childHooks:WorkflowHooks={...options.hooks,
      // executeWorkflowVM records log() and console.* through onLog below.
      // Do not stringify a raw guest object here or deliver each log twice.
      bindVMAwait:bridge=>{childBridge=bridge},phase:()=>{},log:()=>{},
      agent:(prompt:unknown,rawOptions?:unknown)=>{
        // clone and getter reads run inside the hardened child realm. Preserve
        // schema identity for the parent's compiled StructuredOutput cache.
        const cloned=childBridge.clone(rawOptions)
        const snapshot=cloned && typeof cloned==='object'?cloned as Record<string,unknown>:{}
        const identity=childBridge.getProp(rawOptions,'schema')
        if(identity && typeof identity==='object') {
          if(schemas.has(identity))snapshot.schema=schemas.get(identity)
          else if(snapshot.schema!==undefined)schemas.set(identity,snapshot.schema)
        }
        return options.hooks.agent(prompt,{...snapshot,phase})
      },
      workflow:()=>Promise.reject(Error('workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.')),
    }
    // args is an approved JSON value, sanitized before executeWorkflowVM
    // serializes it. Never stringify/coerce a raw parent getter on the host.
    const args=rawArgs===undefined?undefined:structuredClone(options.parentBridge().sanitize(rawArgs))
    const result=await executeWorkflowVM(compiled.vmScript,childHooks,{signal:options.signal,budget:options.budget,args,
      onLog:message=>options.hooks.log(`[${name}] ${message}`)})
    if(result.error) {
      options.hooks.recordFailure(`${phase}: ${result.error}`)
      options.hooks.log(`▸ ${name} failed: ${result.error}`)
      throw Error(result.error)
    }
    options.hooks.log(`▸ ${name} done`)
    return options.parentBridge().clone(result.result)
  }
}
