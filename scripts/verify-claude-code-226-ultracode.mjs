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
console.log(JSON.stringify({version: '2.1.226', binary_sha256: sha256, cases, result: 'PASS', scope: 'availability, policy, keyword, native flag state; NOT workflow executor or full parity'}, null, 2));
