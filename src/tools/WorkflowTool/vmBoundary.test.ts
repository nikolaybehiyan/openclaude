import test from 'node:test'
import assert from 'node:assert/strict'
import {createContext, runInContext} from 'node:vm'
import {hardenWorkflowContext, createWorkflowVMBridge} from './vmBoundary.ts'
import {compileWorkflowScript} from './compiler.ts'

function realm() {
  const context = createContext({}, {codeGeneration: {strings: false, wasm: false}})
  hardenWorkflowContext(context)
  return {context, bridge: createWorkflowVMBridge(context), run: (code: string) => runInContext(code, context, {timeout: 100})}
}

test('intrinsics are frozen without breaking normal instance overrides', () => {
  const {run, context} = realm()
  hardenWorkflowContext(context)
  assert.equal(run('[Promise, Object, Function, Array, Map, Set, Date, Error, TypeError, Uint8Array, Intl.Collator].every(C => Object.isFrozen(C) && Object.isFrozen(C.prototype))'), true)
  assert.equal(run('[JSON, Math, Reflect, Proxy].every(Object.isFrozen)'), true)
  assert.equal(run("class Named extends Error {constructor(){super('message');this.name='Named'}};new Named().name"), 'Named')
  assert.equal(run("Object.assign({}, {toString:42,constructor:'local'}).toString"), 42)
  assert.throws(() => run("'use strict';Promise.prototype.then = () => 42"))
  assert.throws(() => run("Object.defineProperty(globalThis,'then',{value:()=>42})"))
  assert.equal(run('globalThis.then'), undefined)
})

test('nondeterminism, dynamic code and host capabilities remain unavailable', () => {
  const {run} = realm()
  for (const input of ['Date.now()', 'new Date()', 'Date()', '(new Date(0)).constructor.now()', 'Math.random()']) assert.throws(() => run(input), /unavailable in workflow scripts/)
  assert.equal(run('new Date(0).getTime()'), 0)
  assert.equal(run('Date.parse("2020-01-01T00:00:00Z")'), 1577836800000)
  for (const name of ['process','require','WebAssembly','ShadowRealm','FinalizationRegistry','WeakRef','Atomics','SharedArrayBuffer','queueMicrotask','$vm','gc','readFile','Loader']) assert.equal(run(`typeof ${name}`), 'undefined', name)
  for (const code of ['eval("1")','Function("return process")()','(async()=>{}).constructor("return process")()']) assert.throws(() => run(code))
  assert.equal(compileWorkflowScript('return import("node:fs")').ok, false)
  assert.throws(() => createWorkflowVMBridge(createContext({})), /must be hardened/)
})

test('guest getters and forged cap errors cannot escape the value walkers', () => {
  const {bridge, run} = realm()
  const malicious = run(`(() => {const forged=new Proxy({}, {get(){throw Error('host must not read me')}});return {ok:42,get trap(){throw forged}, fn(){}, nested:[1, {get bad(){throw forged}}]}})()`)
  for (const walker of [bridge.sanitize, bridge.clone]) {
    assert.equal(bridge.stringify(walker(malicious)), '{"ok":42,"nested":[1,{}]}')
  }
  const cap = run('new Proxy([], {get(t,k){if(k==="length")return 4097;return Reflect.get(t,k)}})')
  for (const walker of [bridge.sanitize, bridge.clone, bridge.snapshot]) assert.throws(() => walker(cap), /maximum of 4096/)
  const rootThrow = run('new Proxy([], {get(){throw new Proxy({}, {get(){throw 42}})}})')
  for (const walker of [bridge.sanitize, bridge.clone, bridge.snapshot]) assert.throws(() => walker(rootThrow), /unable to read array length/)
  const nestedCap = run('[new Proxy([], {get(t,k){if(k==="length")return 4097;return Reflect.get(t,k)}})]')
  for (const walker of [bridge.sanitize, bridge.clone]) assert.throws(() => walker(nestedCap), /maximum of 4096/)
})

test('cycles, own prototype keys, revoked proxies and unstable lengths are bounded', () => {
  const {bridge, run} = realm()
  const cycle = run('(()=>{const a={};a.self=a;return a})()')
  for (const walker of [bridge.sanitize, bridge.clone]) {
    const result = walker(cycle)
    assert.equal(bridge.getProp(result, 'self'), result)
    assert.equal(bridge.stringify(walker(run('JSON.parse("{\\"__proto__\\":{\\"polluted\\":true},\\"ok\\":1}")'))), '{"ok":1}')
    assert.equal(bridge.stringify(walker(run('new Proxy({}, {ownKeys(){throw 42}})'))), '{}')
  }
  assert.equal(run('Object.prototype.polluted'), undefined)
  const value = run('(()=>{let n=0;globalThis.readCount=()=>n;return new Proxy([1,2],{get(t,k){if(k==="length"){n++;return 2}return Reflect.get(t,k)}})})()')
  assert.equal(bridge.stringify(bridge.clone(value)), '[1,2]')
  assert.equal(run('readCount()'), 1)
})

test('error, string and property extraction stays inside the guest realm', () => {
  const {bridge, run} = realm()
  const hostile = run('({get name(){throw 1},message:"safe",get stack(){throw 2},toString(){throw 3}})')
  assert.deepEqual(JSON.parse(bridge.stringify(bridge.readError(hostile))!), {name:'Error',message:'safe',stack:''})
  assert.equal(bridge.toString(hostile), '<unprintable>')
  assert.equal(bridge.ownString(hostile, 'name'), undefined)
  assert.equal(bridge.getProp(hostile, 'stack'), undefined)
  assert.equal(bridge.readError(42).message, '42')
})

test('await, thenables, async return and iterator results stay on guest promise path', async () => {
  const {bridge, context, run} = realm()
  const compiled = compileWorkflowScript('const value={then(resolve){resolve(42)}};return await value')
  assert.equal(compiled.ok, true)
  if (!compiled.ok) return
  const boxed = await bridge.settle(compiled.vmScript.runInContext(context, {timeout: 100}))
  assert.equal(Object.getPrototypeOf(boxed), null)
  assert.equal(boxed.v, 42)
  const iterator = compileWorkflowScript('async function* seq(){yield {then(r){r(20)}};yield 22};let sum=0;for await(const n of seq())sum+=n;return sum')
  assert.equal(iterator.ok, true)
  if (iterator.ok) assert.equal((await bridge.settle(iterator.vmScript.runInContext(context, {timeout: 100}))).v, 42)
  const original = run('({answer:42})')
  assert.equal((await bridge.settle(original)).v, original)
})
