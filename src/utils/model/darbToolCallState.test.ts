import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binding = {
  owner: 'identity-org-service', organization_uuid: 'org-synthetic', account_uuid: 'account-synthetic',
  connection_id: 'icn_' + 'a'.repeat(32), connection_revision: 1,
  catalog_revision: 'sha256:' + 'b'.repeat(64), model: 'Vendor/Exact-ID',
  supports_1m: false, context_window_tokens: 0,
}

// Real modules, isolated process registry and synthetic config directory. This
// must not bind another test's default-provider process to our frozen model.
function run(code: string, frozen = true) {
  const directory = mkdtempSync(join(tmpdir(), 'darb-tool-state-'))
  try {
    return spawnSync(process.execPath, ['-e', `
      import assert from 'node:assert/strict';
      globalThis.fetch = async () => { throw new Error('fixture_network_disabled') };
      const {darbToolCallStateFields} = await import('./src/utils/model/darbToolCallState.ts');
      const {normalizeMessagesForAPI,stripCallerFieldFromAssistantMessage} = await import('./src/utils/messages.ts');
      const state = {scope:'c'.repeat(64),connection_id:'icn_'+'a'.repeat(32),model:'Vendor/Exact-ID',call_id:'call_exact_9',name:'synthetic_tool',thought_signature:'opaque<&>state'};
      const encode = v => 'darb-tool-call-state-v1:'+Buffer.from(JSON.stringify(v).replace(/[<>&\\u2028\\u2029]/g,c=>'\\\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))).toString('base64');
      const tool = (encoded=encode(state)) => ({type:'tool_use',id:state.call_id,name:state.name,input:{x:1},darb_tool_call_state:encoded});
      const assistant = block => ({type:'assistant',uuid:'00000000-0000-4000-8000-000000000001',timestamp:'2026-09-15T00:00:00Z',message:{id:'msg_synthetic',type:'message',role:'assistant',model:state.model,content:[block],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});
      const normalize = block => normalizeMessagesForAPI([assistant(block),{type:'user',uuid:'00000000-0000-4000-8000-000000000002',timestamp:'2026-09-15T00:00:01Z',message:{role:'user',content:[{type:'tool_result',tool_use_id:block.id,content:'result'}]}}],[]).find(m=>m.type==='assistant').message.content[0];
      ${code}
      console.log('PASS');
    `], {
      cwd: join(import.meta.dir, '../../..'), encoding: 'utf8', timeout: 20000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', CLAUDE_CONFIG_DIR: directory, ENABLE_TOOL_SEARCH: 'false',
        ...(frozen ? { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', DARB_FROZEN_MODEL_CONTEXT_JSON: JSON.stringify(binding) } : {}) },
    })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('real native normalization and caller stripping preserve only recognized frozen tool state', () => {
  const result = run(`
    for (const enabled of ['false','true']) {
      process.env.ENABLE_TOOL_SEARCH=enabled;
      const original={...tool(),signature:'untrusted-generic-signature',extra_content:{google:{thought_signature:'untrusted-raw-state'}}};
      const replay=normalize(original);
      assert.equal(replay.darb_tool_call_state,original.darb_tool_call_state);
      assert.equal(replay.id,original.id); assert.deepEqual(replay.input,original.input);
      assert.equal(replay.extra_content,undefined);
      const stripped=stripCallerFieldFromAssistantMessage(assistant({...original,caller:{type:'direct'}})).message.content[0];
      assert.equal(stripped.darb_tool_call_state,original.darb_tool_call_state);
      assert.equal(stripped.signature,undefined); assert.equal(stripped.extra_content,undefined);
    }
  `)
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('PASS')
})

test('foreign identity, arbitrary shape, malformed encoding and oversized state fail closed', () => {
  const result = run(`
    for (const value of [{...state,connection_id:'icn_'+'d'.repeat(32)},{...state,model:'other'},{...state,call_id:'other'},{...state,name:'other'},{...state,thought_signature:''},{...state,thought_signature:1},{...state,thought_signature:'x'.repeat(65537)},{...state,arbitrary:'drop-me'},{...state,scope:''}]) {
      assert.throws(()=>darbToolCallStateFields(tool(encode(value))),/Darb tool call state/);
      assert.throws(()=>normalize(tool(encode(value))),/Darb tool call state/);
    }
    for (const value of [null,'',3,'other-prefix','darb-tool-call-state-v1:!!!!','x'.repeat(131073)]) assert.throws(()=>darbToolCallStateFields(tool(value)),/Darb tool call state/);
    const duplicate=JSON.stringify(state).replace('{','{"scope":"foreign",');
    assert.throws(()=>darbToolCallStateFields(tool('darb-tool-call-state-v1:'+Buffer.from(duplicate).toString('base64'))),/Darb tool call state/);
    assert.deepEqual(darbToolCallStateFields({id:'standard_call',name:'standard_tool'}),{});
  `)
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('PASS')
})

test('unmanaged default runtime rejects custom state and preserves ordinary tools', () => {
  const result = run(`
    assert.throws(()=>normalize(tool()),/Darb tool call state/);
    const ordinary={type:'tool_use',id:'ordinary',name:'ordinary',input:{}};
    assert.deepEqual(normalize(ordinary),ordinary);
  `, false)
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('PASS')
})
