import { expect, test } from 'bun:test'
import { createContext } from 'node:vm'
import { compileWorkflowScript, rewriteWorkflowAsync } from './compiler.js'

// These fixtures prove compiler semantics, NOT VM escape resistance. No host
// capabilities are injected; the unported runner/membrane remains disabled.
async function run(script: string) {
  const result = compileWorkflowScript(script)
  if (!result.ok) throw Error(result.error)
  const context = createContext({}, {codeGeneration: {strings: false, wasm: false}})
  return result.vmScript.runInContext(context, {timeout: 100})
}
test('async await, expression return and generator paths keep values', async () => {
  expect(await run('const f = async x => x+1; return await f(41)')).toBe(42)
  expect(await run('async function* f(){yield Promise.resolve(1); yield* [Promise.resolve(2),3]; return 4}; let sum=0; for await(const n of f()) sum+=n; return sum')).toBe(6)
  expect(await run('async function f(){return Promise.resolve(42)};return f()')).toBe(42)
})
test('async iteration closes on break and rejects malformed iterator results', async () => {
  expect(await run('let closed=false;const it={*[Symbol.iterator](){try{yield 1;yield 2}finally{closed=true}}};for await (const v of it) break;return closed')).toBe(true)
  await expect(run('const it = {[Symbol.iterator](){return {next(){return 1}}}};for await(const v of it){}')).rejects.toThrow('Iterator result is not an object')
})
test('imports, reserved identifiers and strict syntax cannot enter the runner', () => {
  for (const script of ["return import('node:fs')", 'const __wRg$evil = 1', 'with({}){}', 'const x: number = 1']) {
    expect(compileWorkflowScript(script).ok).toBe(false)
  }
})
test('only async returns/yields are rewritten, not synchronous helpers', () => {
  const transformed = rewriteWorkflowAsync('function f(){return 1};async function g(){return 2};return g()')
  expect(transformed).toContain('function f(){return 1}')
  expect(transformed).toContain('async function g(){return  __wRg$((2))}')
})
