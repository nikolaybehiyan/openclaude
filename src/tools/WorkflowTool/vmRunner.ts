import {createContext, runInContext, type Script} from 'node:vm'
import {hardenWorkflowContext, createWorkflowVMBridge, type WorkflowVMBridge, type WorkflowVMFunction} from './vmBoundary.ts'
import {createWorkflowTimers, workflowHostError, wrapWorkflowHostAsync, wrapWorkflowHostSync} from './hostBoundary.ts'

export interface WorkflowBudget {total?: number | null; getTurnSpent(): number}
export interface WorkflowHooks {
  agent: WorkflowVMFunction
  parallel: WorkflowVMFunction
  pipeline: WorkflowVMFunction
  workflow: WorkflowVMFunction
  log(message: unknown): void
  phase(title: unknown): void
  bindVMAwait(bridge: WorkflowVMBridge): void
  getAgentCount(): number
  getFailures(): string[]
}

function inertString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' && typeof value !== 'function') return String(value)
  return typeof value === 'function' ? '[function]' : '[object]'
}

// Dha logging semantics; closures only see primitives or snapshots created
// by the hardened guest walker. Never JSON.stringify a raw guest object here.
export function workflowConsole(log: (line: string) => void, read: () => WorkflowVMBridge) {
  function format(values: unknown[]) {
    return values.map(value => {
      if (typeof value === 'string') return value
      if (value === null || typeof value !== 'object' && typeof value !== 'function') {
        try {return JSON.stringify(value)} catch {return `[${typeof value}]`}
      }
      let serialized: string
      try {
        const json = JSON.stringify(read().sanitize(value))
        if (json !== undefined && json !== '{}') return json
        serialized = json ?? `[${typeof value}]`
      } catch (error) {
        const message = read().readError(error).message
        return message.includes('exceeds the maximum') ? `[${typeof value}: array exceeds the 4096-element logging cap]` : `[${typeof value}]`
      }
      const text = read().toString(value)
      return text === '[object Object]' || text === '<unprintable>' ? serialized : text
    }).join(' ')
  }
  const method = (prefix: string) => wrapWorkflowHostSync((...args: unknown[]) => log(prefix + format(args)))
  return {__proto__: null, log:method(''), info:method(''), debug:method(''), warn:method('[warn] '), error:method('[error] ')}
}

export interface WorkflowVMResult {
  result: unknown
  agentCount: number
  logs: string[]
  failures: string[]
  durationMs: number
  error?: string
}

// s$p/l$p VM execution component, not the Workflow tool. Hooks must come from
// the qualified agent orchestrator: they retain current CanUseTool, budget,
// frozen model selection, task ownership and the approved child resolver.
// No default permissive agent or tool runner is supplied by this module.
export async function executeWorkflowVM(script: Script, hooks: WorkflowHooks, options: {
  signal?: AbortSignal
  budget?: WorkflowBudget
  args?: unknown // host-owned, approved JSON input only
  syncTimeoutMs?: number
  onLog?: (message: string) => void
} = {}): Promise<WorkflowVMResult> {
  const started = Date.now(), logs: string[] = []
  const record = (message: string) => {if (logs.length < 1000) logs.push(message); options.onLog?.(message)}
  let bridge: WorkflowVMBridge | undefined
  const timers = createWorkflowTimers(options.signal)
  let removeAbort: (()=>void) | undefined
  try {
  const budget = Object.freeze({__proto__: null, total:options.budget?.total ?? null,
    spent:wrapWorkflowHostSync(()=>options.budget?.getTurnSpent() ?? 0),
    remaining:wrapWorkflowHostSync(()=>options.budget?.total == null ? Infinity : Math.max(0,options.budget.total-options.budget.getTurnSpent()))})
  const context = createContext({__proto__: null,
    log:wrapWorkflowHostSync((value: unknown)=>{hooks.log(value);record(inertString(value))}),
    phase:wrapWorkflowHostSync(hooks.phase),
    console:workflowConsole(record,()=>{if (!bridge) throw Error('Workflow boundary is not initialized');return bridge}),budget,
    setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,
  }, {codeGeneration:{strings:false,wasm:false}})
  hardenWorkflowContext(context)
  bridge = createWorkflowVMBridge(context)
  timers.bindVMInvoke(runInContext('(fn => {fn()})',context))
  for (const name of ['agent','parallel','pipeline','workflow'] as const) {
    Object.defineProperty(context,name,{value:bridge.wrapAsync(wrapWorkflowHostAsync(hooks[name])),writable:true,enumerable:true,configurable:true})
  }
  hooks.bindVMAwait(bridge)
    const args = options.args === undefined ? undefined : JSON.stringify(options.args)
    Object.defineProperty(context,'args',{value:args === undefined ? undefined : runInContext(`JSON.parse(${JSON.stringify(args)})`,context),writable:true,enumerable:true,configurable:true})
    if (options.signal?.aborted) throw Error('Workflow aborted')
    const execution = bridge.settle(script.runInContext(context,{timeout:options.syncTimeoutMs ?? 30000}))
    // Suppress late rejection when abort wins the race. The parent abort
    // controller also kills outstanding agents; timer cleanup is local here.
    execution.catch(()=>{})
    const aborted = new Promise<never>((_resolve,reject)=> {
      if (!options.signal) return
      const abort = ()=>reject(Error('Workflow aborted'))
      if (options.signal.aborted) abort()
      else {options.signal.addEventListener('abort',abort);removeAbort=()=>options.signal?.removeEventListener('abort',abort)}
    })
    const boxed = options.signal ? await Promise.race([execution,aborted]) : await execution
    if (typeof boxed.v === 'function') throw Error('workflow result cannot be a function')
    const value = boxed.v !== null && typeof boxed.v === 'object' ? bridge.sanitize(boxed.v) : boxed.v
    let result: unknown
    try {result = structuredClone(value)}
    catch (error) {
      if (value === null || typeof value !== 'object') throw error
      result = JSON.parse(JSON.stringify(value,(_key,item)=>typeof item === 'function' ? undefined : item) ?? 'null')
    }
    JSON.stringify(result)
    return {result,agentCount:hooks.getAgentCount(),logs,failures:hooks.getFailures(),durationMs:Date.now()-started}
  } catch (error) {
    const fields = bridge ? bridge.readError(error) : workflowHostError(error)
    let text = fields.message ? `${fields.name}: ${fields.message}` : fields.name
    if (fields.stack) {
      const lines = fields.stack.split('\n'), frames = lines.slice(1).filter(line=>line.trim().startsWith('at '))
      text = frames.length <= 5 ? fields.stack : [lines[0] ?? '',...frames.slice(0,5)].join('\n')
    }
    return {result:null,agentCount:hooks.getAgentCount(),logs,failures:hooks.getFailures(),durationMs:Date.now()-started,error:text}
  } finally {removeAbort?.();timers.dispose()}
}
