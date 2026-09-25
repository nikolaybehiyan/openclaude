#!/usr/bin/env bun
// Differential contract checks against inert source extracted from a pinned
// official binary. Never starts the executable, its main(), network or tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import path from 'node:path';
import {applyNativeReasoningFlags, findUltracodeKeyword, workflowAvailability, workflowsEnabled} from '../src/utils/ultracodePolicy.ts';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import {parseWorkflowScript} from '../src/tools/WorkflowTool/scriptParser.ts';
import {rewriteWorkflowAsync, compileWorkflowScript} from '../src/tools/WorkflowTool/compiler.ts';
import {workflowInvocationKey, workflowInvocationOptions, indexWorkflowJournal} from '../src/tools/WorkflowTool/journal.ts';
import {hardenWorkflowContext, createWorkflowVMBridge} from '../src/tools/WorkflowTool/vmBoundary.ts';
import {workflowHostError, wrapWorkflowHostSync, wrapWorkflowHostAsync} from '../src/tools/WorkflowTool/hostBoundary.ts';

const [binaryPath, parserRoot] = process.argv.slice(2);
if (!binaryPath || !parserRoot) throw Error('Usage: bun scripts/verify-claude-code-226-ultracode.mjs <official-2.1.226-darwin-arm64> <babel-package-root>');
const binary = fs.readFileSync(binaryPath);
const sha256 = crypto.createHash('sha256').update(binary).digest('hex');
assert.equal(sha256, '013a1cf17df5ff1dcc189d5d6fd3fdd5f097ddc3cd41aa9992e99805574febbe');
const source = binary.subarray(245797944, 269783626).toString('utf8');
const require = createRequire(path.join(path.resolve(parserRoot), 'package.json'));
const body = require('@babel/parser').parse(source, {sourceType: 'unambiguous'}).program.body[0].expression.body.body;
function declaration(name) {
  const matches = body.filter(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.equal(matches.length, 1, `unique reference ${name}`);
  return source.slice(matches[0].start, matches[0].end);
}
const declarations = ['Vpr', 'Ck', 'bon', 'jbo', 'zbo', 'g_s', 'nw_', 'gfa'].map(declaration).join('\n');
const clone = value => JSON.parse(JSON.stringify(value));
let cases = 0;
for (const subscription of ['pro', 'max', 'team', 'enterprise', null]) {
  for (const env of [undefined, true, false]) for (const gate of [true, false])
  for (const policy of [true, false]) for (const disabledEnv of [true, false])
  for (const enable of [undefined, true, false]) for (const disable of [undefined, true, false]) {
    const settings = {enableWorkflows: enable, disableWorkflows: disable};
    const context = vm.createContext({
      process: {env: {CLAUDE_CODE_WORKFLOWS: env, CLAUDE_CODE_DISABLE_WORKFLOWS: disabledEnv}},
      yr: value => value === true, md: value => value === false,
      nt: () => gate, Cl: () => subscription, Bs: () => policy,
      _M: () => ({settings}), qbo: undefined,
    }, {codeGeneration: {strings: false, wasm: false}});
    const actual = workflowAvailability({envEnabled: env === true, envDisabled: env === false, gateEnabled: gate, subscription});
    vm.runInContext(declarations, context, {timeout: 1000});
    assert.deepEqual(actual, clone(vm.runInContext('nw_()', context, {timeout: 1000})));
    assert.equal(workflowsEnabled({settings, disabledByEnv: disabledEnv, policyAllowed: policy, availability: actual}), vm.runInContext('Ck()', context, {timeout: 1000}));
    cases++;
  }
}
const words = ['ultracode', 'ULTRACODE', 'Ultracode', 'not_ultracode', 'ултра ultracode'];
const surround = ['', ' ', '`', '"', "'", '[', ']', '[[', '(', ')', '{', '}', '<', '>', '/', '\\', '-', '.', '?', '.js', "it's ", '<<'];
const keywordContext = vm.createContext({BOp: {'`': '`', '"': '"', '<': '>', '{': '}', '[': ']', '(': ')', "'": "'"}}, {codeGeneration: {strings: false, wasm: false}});
vm.runInContext(declaration('gfa'), keywordContext);
for (const word of words) for (const left of surround) for (const right of surround) {
  const text = left + word + right;
  keywordContext.input = text;
  assert.deepEqual(findUltracodeKeyword(text), clone(vm.runInContext('gfa(input, "ultracode")', keywordContext, {timeout: 1000})), text);
  cases++;
}
// Pin the actual native control handler, not a rewritten model of it.
const start = source.indexOf('if("effortLevel"in Xn){');
assert.notEqual(start, -1);
const end = source.indexOf('vr(Et)}else if(Et.request.subtype==="get_settings")', start);
assert.ok(end > start && end - start < 1500);
const handler = source.slice(start, end);
assert.ok(handler.includes('if("ultracode"in Xn)'));
const parse = value => ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value : undefined;
for (const effort of [undefined, null, 'low', 'high', 'xhigh', 'max', 'ultracode', 'invalid'])
for (const ultra of [undefined, null, true, false])
for (const initial of [{}, {effortValue: 'high'}, {effortValue: 'xhigh', ultracode: true}]) {
  const incoming = {...(effort !== undefined ? {effortLevel: effort} : {}), ...(ultra !== undefined ? {ultracode: ultra} : {})};
  let state = {...initial};
  const alias = value => typeof value === 'string' && value.trim().toLowerCase() === 'ultracode' ? 'ultracode' : undefined;
  const context = vm.createContext({Xn: incoming, l: update => { state = update(state); }, RG: () => {}, AG: parse,
    $bo: value => alias(value) ? 'xhigh' : undefined, Son: alias, e: {sessionState: {notifyMetadataChanged: () => {}}}},
    {codeGeneration: {strings: false, wasm: false}});
  vm.runInContext(handler, context, {timeout: 1000});
  assert.deepEqual(clone(applyNativeReasoningFlags(initial, incoming, parse)), clone(state));
  cases++;
}
const scriptContext = vm.createContext({Error, SyntaxError, bHo: () => acorn, Rha: () => walk, uy: '__wRg$',
  KD: 524288, oFs: 80, kgy: new Set(['__proto__', 'constructor', 'prototype']), sg: (text, count) => text.repeat(count),
  uZo: vm, Te: () => {}, fe: () => {}, Lze: message => Error(message)}, {codeGeneration: {strings: true, wasm: false}});
// Only compiler/parser declarations run here; generated scripts are inspected
// and compared, never run with a host capability or a user-provided body.
vm.runInContext(['pP', 'Pgy', 'Zfd', 'Qfd', 'Ogy', 'Dgy', 'Hgy', 'Igy', 'xgy', 'jBb', 'Fwt'].map(declaration).join('\n'), scriptContext);
const metas = ["name:'n',description:'d'", "name:'',description:'d'", "name:2,description:'d'", "name:'n'", "name:'n',description:''",
  "name:'n',description:'d',phases:[null,{}, {title:'',detail:3,model:'m'}]", "name:`n`,description:'d',title:'',whenToUse:''",
  "name:'n',description:'d',x:[1,-2,null,{a:'b'}]", "name:run(),description:'d'", "get name(){return 'n'},description:'d'",
  "name:'n',description:'d',...extra", "['name']:'n',description:'d'", "name:'n',description:'d',__proto__:{}",
  "name:'n',description:'d',x:{constructor:'x'}", "name:'n',description:'d',x:[,1]", "name:`${run()}`,description:'d'",
  "name:'n',description:'d',x:undefined", "name:'n',description:'d',x:+1", "name:'n',description:'d',x:[...a]"];
for (const meta of metas) for (const before of ['', '// comment\n', ';', "'use strict';"]) {
  const input = before + `export const meta={${meta}};\nreturn 42`;
  assert.deepEqual(clone(parseWorkflowScript(input)), clone(scriptContext.pP(input)), input); cases++;
}
for (const input of ['', ' '.repeat(524289), 'export let meta={name:"n",description:"d"}',
  'export const meta={name:"n",description:"d"};const x: number=1']) {
  assert.deepEqual(clone(parseWorkflowScript(input)), clone(scriptContext.pP(input))); cases++;
}
const bodies = ['return 42', 'const f=async x=>x;return await f(2)', 'async function f(){return await 2};return f()',
  'function f(){return 1}; return f()', 'async function* f(){yield await 2;yield* [1,2];return 3};return f()',
  'let n=0;for await(const x of [1,2])n+=x;return n', 'return (async()=>await 1)()', 'return await (async()=>1)()',
  'const __wRg$evil=1', "return import('node:fs')", 'with({}){}', 'const x: number=1', 'const f=async()=>({a:1});return f()',
  'return await await 42', 'for await(const x of (async function*(){yield 1})()){if(x)break};return 0'];
for (const input of bodies) {
  const ours = compileWorkflowScript(input), theirs = scriptContext.Fwt(input);
  assert.equal(ours.ok, theirs.ok, input);
  if (ours.ok) {
    assert.equal(rewriteWorkflowAsync(input), scriptContext.jBb(input), input);
    const emptyContext = () => vm.createContext({}, {codeGeneration: {strings: false, wasm: false}});
    assert.deepEqual(clone(await ours.vmScript.runInContext(emptyContext(), {timeout: 100})),
      clone(await theirs.vmScript.runInContext(emptyContext(), {timeout: 100})), input);
  }
  // Parser errors depend on the compile-validation realm; both must refuse.
  cases++;
}
const journalContext = vm.createContext({zNp: crypto, GBb: 'v2'}, {codeGeneration: {strings: false, wasm: false}});
vm.runInContext(['VBb', 'WNp', 'jNp'].map(declaration).join('\n'), journalContext);
for (const options of [undefined, {}, {model: 'glm', effort: 'xhigh'}, {schema: {b: 1, a: 2}, agentType: 'Explore'},
  {schema: [0, false, null, ''], isolation: 'worktree'}, {label: 'ignored', stallMs: 50}, {model: 'kimi', schema: JSON.parse('{"__proto__":4,"a":1}')}]) {
  assert.equal(workflowInvocationOptions(options), journalContext.VBb(options));
  for (const prompt of ['', 'review', 'кириллица']) for (const site of ['0', 'parallel:2']) {
    assert.equal(workflowInvocationKey(prompt, options, site), journalContext.WNp(prompt, options, site)); cases++;
  }
}
const records = [{type: 'started', key: 'pending', agentId: 'a'}, {type: 'started', key: 'pending', agentId: 'b'},
  ...[false, 0, '', [], {}, 42].map((result, index) => ({type: 'result', key: String(index), agentId: 'c', result}))];
const indexed = indexWorkflowJournal(records), reference = journalContext.jNp(records);
assert.deepEqual(clone([...indexed.started]), clone([...reference.started]));
assert.deepEqual(clone([...indexed.results]), clone([...reference.results])); cases++;
const boundaryOracle = vm.createContext({LRe:vm,mse:4096}, {codeGeneration:{strings:false,wasm:false}});
vm.runInContext(['mGt','LXo','NXo','PXo','NIr','oHp','OXo','IXo'].map(declaration).join('\n'),boundaryOracle);
const ownRealm = vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
hardenWorkflowContext(ownRealm);
const referenceRealm = vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
boundaryOracle.mGt(referenceRealm);
const ownBridge = createWorkflowVMBridge(ownRealm);
const referenceValues = boundaryOracle.NXo(referenceRealm), referenceStrings = boundaryOracle.LXo(referenceRealm);
const referenceBridge = {...referenceValues,clone:boundaryOracle.PXo(referenceRealm),readError:boundaryOracle.IXo(referenceRealm),
  stringify:referenceStrings.vmStringify,toString:referenceStrings.vmToStr,ownString:referenceStrings.vmOwnString};
function outcome(bridge, fn) {
  try {return {ok:true,json:bridge.stringify(bridge.sanitize(fn()))};}
  catch(error) {const fields=bridge.readError(error);return {ok:false,name:fields.name,message:fields.message};}
}
const boundaryInputs = ['42','null','undefined','[false,0,"",null]', '({answer:42,fn(){}})',
  'JSON.parse("{\\"__proto__\\":1,\\"constructor\\":2,\\"ok\\":true}")',
  '({get bad(){throw 42},ok:1})','({get bad(){throw new Proxy({},{get(){throw 42}})},ok:1})',
  'new Proxy({}, {ownKeys(){throw 42}})',
  '(()=>{const {proxy,revoke}=Proxy.revocable({},{});revoke();return proxy})()',
  ...[4096,4097,1.5,Infinity,-1,'large'].map(length=>`new Proxy([], {get(t,k){if(k==="length")return ${JSON.stringify(length)};return undefined}})`),
  'new Proxy([], {get(){throw new Proxy({},{get(){throw 42}})}})',
  '[new Proxy([], {get(t,k){if(k==="length")return 4097;return undefined}})]',
  '({get name(){throw 42},message:"safe",get stack(){throw 42}})',
  '(()=>{const a={};a.self=a;return a})()'];
for(const expression of boundaryInputs) {
  const ours=vm.runInContext(expression,ownRealm,{timeout:100});
  const theirs=vm.runInContext(expression,referenceRealm,{timeout:100});
  for(const method of ['clone','sanitize','snapshot','toString','readError']) {
    assert.deepEqual(outcome(ownBridge,()=>ownBridge[method](ours)),outcome(referenceBridge,()=>referenceBridge[method](theirs)),method+':'+expression);
    cases++;
  }
}
boundaryOracle.Bfa = undefined;
vm.runInContext(['J$b','NAn','Lze','NRe','HXo'].map(declaration).join('\n'),boundaryOracle);
for(const expression of ['null','undefined','42','"literal"','12n','({name:"Custom",message:"safe",stack:"stack"})',
  '({get name(){throw 1},message:"safe",get stack(){throw 2}})', 'new Proxy({}, {get(){throw 42}})']) {
  const input = vm.runInContext(expression,referenceRealm,{timeout:100});
  const fields = boundaryOracle.NAn(input);
  const reference = boundaryOracle.Lze(fields.msg,fields.name,fields.stack);
  const ours = workflowHostError(input);
  assert.deepEqual({...ours,toString:ours.toString()}, {...reference,toString:reference.toString()});
  assert.equal(Object.getPrototypeOf(ours),null);assert.equal(Object.getPrototypeOf(ours.toString),null);
  for(const [ownWrap,refWrap] of [[wrapWorkflowHostSync,boundaryOracle.NRe],[wrapWorkflowHostAsync,boundaryOracle.HXo]]) {
    const throwing=()=>{throw input};
    const own=ownWrap(throwing),ref=refWrap(throwing);
    const failure=async fn=>{try{await fn();throw Error('did not throw')}catch(e){return {name:e.name,message:e.message,stack:e.stack}}};
    assert.deepEqual(await failure(own),await failure(ref));cases++;
  }
  cases++;
}
console.log(JSON.stringify({version: '2.1.226', binary_sha256: sha256, cases, result: 'PASS', scope: 'availability, policy, keyword, native flag state, metadata, async compiler, journal identity/index, hardened VM value boundary and host errors; NOT workflow executor or full parity'}, null, 2));
