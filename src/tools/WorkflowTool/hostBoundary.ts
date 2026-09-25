import {createContext, runInContext} from 'node:vm'
import {hardenWorkflowContext, type WorkflowVMFunction} from './vmBoundary.ts'

// 2.1.226 J$b/NAn/Lze/NRe/HXo: inspect thrown values in a separate hardened
// realm, never by reading a hostile getter or coercing an object on the host.
let readThrown: ((value: unknown) => {msg: string; name: string; stack?: string}) | undefined

function thrownFields(value: unknown): {msg: string; name: string; stack?: string} {
  try {
    if (!readThrown) {
      const context = createContext(Object.create(null), {codeGeneration: {strings: false, wasm: false}})
      hardenWorkflowContext(context)
      readThrown = runInContext(`(e => {
        let msg, name = 'Error', stack
        try { const m = e?.message; msg = typeof m === 'string' ? m : typeof e === 'string' ? e : '<non-string error>' }
        catch { msg = '<unprintable thrown value>' }
        try { const n = e?.name; if (typeof n === 'string') name = n } catch {}
        try { const s = e?.stack; if (typeof s === 'string') stack = s } catch {}
        return {__proto__: null, msg, name, stack}
      })`, context, {timeout: 1000})
    }
    const result = readThrown!(value)
    return {msg: typeof result.msg === 'string' ? result.msg : '<unprintable thrown value>',
      name: typeof result.name === 'string' ? result.name : 'Error',
      stack: typeof result.stack === 'string' ? result.stack : undefined}
  } catch { return {msg: '<unprintable thrown value>', name: 'Error'} }
}

export function workflowHostError(value: unknown) {
  const {msg, name, stack} = thrownFields(value)
  const toString = () => `${name}: ${msg}`
  Object.setPrototypeOf(toString, null)
  Object.freeze(toString)
  return Object.freeze({__proto__: null, name, message: msg, stack: stack ?? `${name}: ${msg}`, toString})
}

export function wrapWorkflowHostSync(fn: WorkflowVMFunction): WorkflowVMFunction {
  const wrapped = (...args: unknown[]) => {
    try { return fn(...args) }
    catch (error) { throw workflowHostError(error) }
  }
  return Object.setPrototypeOf(wrapped, null)
}

export function wrapWorkflowHostAsync(fn: WorkflowVMFunction): WorkflowVMFunction {
  const wrapped = async (...args: unknown[]) => {
    try { return await fn(...args) }
    catch (error) { throw workflowHostError(error) }
  }
  return Object.setPrototypeOf(wrapped, null)
}

// DNp timer contract. Bind invocation through the guest realm before executing
// any script. dispose() is a host-only lifecycle adapter, not a guest API;
// it also releases the abort listener when a run finishes normally.
export function createWorkflowTimers(signal?: AbortSignal) {
  const timers = new Set<number>()
  let invoke: WorkflowVMFunction = fn => fn()
  let disposed = false
  const clear = () => { for (const timer of timers) clearTimeout(timer); timers.clear() }
  signal?.addEventListener('abort', clear, {once: true})
  return {
    setTimeout: wrapWorkflowHostSync((callback: unknown, delay: unknown) => {
      if (disposed || signal?.aborted) return 0
      // Only primitive delays may be coerced. Never execute a guest object's
      // valueOf/toString as an incidental host timer argument conversion.
      const milliseconds = typeof delay === 'number' ? delay : typeof delay === 'string' ? +delay || 0 : 0
      const timer = Number(setTimeout(() => {
        timers.delete(timer)
        if (disposed || signal?.aborted) return
        try { invoke(callback) } catch {}
      }, milliseconds))
      timers.add(timer)
      return timer
    }),
    clearTimeout: wrapWorkflowHostSync((timer: unknown) => {
      if (typeof timer === 'number' || typeof timer === 'string') {
        const id = typeof timer === 'number' ? timer : +timer
        if (timers.has(id)) { timers.delete(id); clearTimeout(id) }
      }
    }),
    bindVMInvoke(fn: WorkflowVMFunction) { invoke = fn },
    dispose() { disposed = true; clear(); signal?.removeEventListener('abort', clear) },
  }
}
