import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DarbFrozenContextRegistry } from './darbFrozenContext.js'
import { isProviderManagedEnvVar } from '../managedEnvConstants.js'

const binding = {
  owner: 'identity-org-service', organization_uuid: 'org-a', account_uuid: 'account-a',
  connection_id: 'icn_' + 'a'.repeat(32), connection_revision: 2,
  catalog_revision: 'sha256:' + 'b'.repeat(64), model: 'Vendor/Exact-ID',
  supports_1m: true, context_window_tokens: 1000000,
}

test('context binding is exact, immutable and idempotent without retaining secrets', () => {
  const registry = new DarbFrozenContextRegistry()
  expect(registry.get('unknown')).toBeUndefined()
  const frozen = registry.configure({ ...binding, api_key: 'not-retained' })
  expect(registry.configure({ ...binding })).toBe(frozen)
  expect(Object.isFrozen(frozen)).toBe(true)
  expect(JSON.stringify(frozen)).not.toContain('not-retained')
  expect(registry.get(binding.model)?.context_window_tokens).toBe(1000000)
  expect(() => registry.get('vendor/exact-id')).toThrow('exact model mismatch')
  expect(() => registry.get(`${binding.model}[1m]`)).toThrow('exact model mismatch')
})

test('changed account, organization, gateway, revision, digest or variant requires a new process', () => {
  for (const change of [
    { account_uuid: 'account-b' }, { organization_uuid: 'org-b' },
    { connection_id: 'icn_' + 'c'.repeat(32) }, { connection_revision: 3 },
    { catalog_revision: 'sha256:' + 'c'.repeat(64) }, { model: 'other' },
    { context_window_tokens: 0 }, { max_input_tokens: 1000000 }, { max_output_tokens: 8192 }, { max_context_tokens: 1000000 },
  ]) {
    const registry = new DarbFrozenContextRegistry()
    registry.configure(binding)
    expect(() => registry.configure({ ...binding, ...change })).toThrow('restart')
    expect(registry.get(binding.model)?.context_window_tokens).toBe(1000000)
  }
})

test('only explicit standard and supported 1M choices are accepted', () => {
  for (const change of [
    { context_window_tokens: undefined }, { context_window_tokens: 128000 },
    { context_window_tokens: '1000000' }, { supports_1m: false },
    { connection_revision: Number.MAX_SAFE_INTEGER + 1 }, { model: 'model\n' },
  ]) expect(() => new DarbFrozenContextRegistry().configure({ ...binding, ...change })).toThrow('invalid')
  expect(new DarbFrozenContextRegistry().configure({ ...binding, context_window_tokens: 0, supports_1m: false }).context_window_tokens).toBe(0)
  expect(isProviderManagedEnvVar('DARB_FROZEN_MODEL_CONTEXT_JSON')).toBe(true)
})

test('capacity is optional, positive and exact; contradictory explicit 1M fails closed', () => {
  for (const max_input_tokens of [0, -1, 0.5, '128000', null, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new DarbFrozenContextRegistry().configure({ ...binding, context_window_tokens: 0, max_input_tokens })).toThrow('invalid')
  }
  for (const max_input_tokens of [128000, 262144]) {
    expect(() => new DarbFrozenContextRegistry().configure({ ...binding, max_input_tokens })).toThrow('invalid')
  }
  expect(new DarbFrozenContextRegistry().configure({ ...binding, max_input_tokens: 1000000 }).max_input_tokens).toBe(1000000)
  expect(new DarbFrozenContextRegistry().configure(binding).max_input_tokens).toBeUndefined()
})

test('output capacity is optional, strictly numeric and cannot rebind a process', () => {
  for (const max_output_tokens of [0, -1, 0.5, '8192', null, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new DarbFrozenContextRegistry().configure({ ...binding, max_output_tokens })).toThrow('invalid')
  }
  const registry = new DarbFrozenContextRegistry()
  expect(registry.configure({ ...binding, max_output_tokens: 8192 }).max_output_tokens).toBe(8192)
  expect(() => registry.configure({ ...binding, max_output_tokens: 4096 })).toThrow('restart')
  expect(new DarbFrozenContextRegistry().configure(binding).max_output_tokens).toBeUndefined()
})

function runAccessor(frozen: unknown, extra: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'darb-context-'))
  try {
    return spawnSync(process.execPath, ['-e', `
      const c = await import('./src/utils/context.ts');
      const exact = process.env.TEST_EXACT_MODEL;
      if (process.env.TEST_INPUT_BUDGET) {
        const compact = await import('./src/services/compact/autoCompact.ts');
        console.log(JSON.stringify({budget:c.getKnownDarbInputBudget(exact,8192),effective:compact.getEffectiveContextWindowSize(exact),threshold:compact.getAutoCompactThreshold(exact)}));
      } else if (process.env.TEST_OUTPUT_CAPACITY) {
        const api = await import('./src/services/api/claude.ts');
        console.log(JSON.stringify({limits:c.getModelMaxOutputTokens(exact),capacity:c.getKnownDarbModelOutputCapacity(exact),effective:api.getMaxOutputTokensForModel(exact)}));
      } else if (process.env.TEST_FROZEN_HELPERS) {
        const m = await import('./src/utils/model/model.ts');
        const a = await import('./src/utils/model/agent.ts');
        const builtins = await import('./src/tools/AgentTool/builtInAgents.ts');
        const options = await import('./src/utils/model/modelOptions.ts');
        const validate = await import('./src/utils/model/validateModel.ts');
        const helpers = [m.getMainLoopModel,m.getSmallFastModel,m.getDefaultMainLoopModel,m.getDefaultSonnetModel,m.getDefaultOpusModel,m.getDefaultHaikuModel].map(f=>f());
        let rejected = 0;
        for (const f of [()=>m.parseUserSpecifiedModel('haiku'),()=>m.normalizeModelStringForAPI('haiku'),()=>a.getAgentModel('haiku',exact)]) { try { f(); } catch { rejected++; } }
        console.log(JSON.stringify({helpers,wire:m.normalizeModelStringForAPI(exact),parsed:m.parseUserSpecifiedModel(exact),agent:a.getAgentModel('inherit',exact),builtins:builtins.getBuiltInAgents().every(a=>a.model==='inherit'),options:options.getModelOptions().map(m=>m.value),valid:await validate.validateModel(exact),rejected}));
      } else console.log(JSON.stringify({window:c.getContextWindowForModel(exact),oneM:c.has1mContext(exact),supported:c.modelSupports1M(exact),capacity:c.getKnownDarbModelInputCapacity(exact)}));
      process.exit(0);
    `], {
      cwd: join(import.meta.dir, '../../..'), encoding: 'utf8', timeout: 20000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', CLAUDE_CONFIG_DIR: directory,
        TEST_EXACT_MODEL: binding.model, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        ...(frozen === undefined ? {} : { DARB_FROZEN_MODEL_CONTEXT_JSON: JSON.stringify(frozen) }), ...extra },
    })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('total context is optional, strict and distinct from input/output and variant', () => {
  for (const max_context_tokens of [0, -1, 0.5, '131072', null, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new DarbFrozenContextRegistry().configure({ ...binding, context_window_tokens: 0, max_context_tokens })).toThrow('invalid')
  }
  expect(() => new DarbFrozenContextRegistry().configure({ ...binding, max_context_tokens: 131072 })).toThrow('invalid')
  const context = new DarbFrozenContextRegistry().configure({ ...binding, context_window_tokens: 0, max_context_tokens: 131072 })
  expect(context.max_context_tokens).toBe(131072)
  expect(context.max_input_tokens).toBeUndefined()
  expect(context.max_output_tokens).toBeUndefined()
  expect(context.context_window_tokens).toBe(0)
})

test('known total context wins without removing legacy input and 200k fallbacks', () => {
  for (const max_context_tokens of [131072, 262144, 1048576]) {
    const result = runAccessor({ ...binding, context_window_tokens: 0, max_context_tokens, max_input_tokens: 65536 })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ window: max_context_tokens, oneM: false, supported: true, capacity: 65536 })
  }
  const totalOnly = runAccessor({ ...binding, context_window_tokens: 0, max_context_tokens: 131072 })
  expect(totalOnly.status, totalOnly.stderr).toBe(0)
  expect(JSON.parse(totalOnly.stdout)).toEqual({ window: 131072, oneM: false, supported: true, capacity: null })
  const disabled = runAccessor({ ...binding, context_window_tokens: 0, max_context_tokens: 1048576 }, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' })
  expect(disabled.status, disabled.stderr).toBe(0)
  expect(JSON.parse(disabled.stdout).window).toBe(200000)
}, 30000)

test('input ceilings and output reservations constrain compaction without inflating small known windows', () => {
  const cases = [
    {max_context_tokens:131072,max_input_tokens:65536,max_output_tokens:8192,budget:65536,effective:65536,threshold:58983},
    {max_context_tokens:131072,max_output_tokens:8192,budget:122880,effective:122880,threshold:110592},
    {max_context_tokens:16384,max_output_tokens:8192,budget:8192,effective:8192,threshold:7373},
  ]
  for (const {budget,effective,threshold,...limits} of cases) {
    const result=runAccessor({...binding,context_window_tokens:0,...limits},{TEST_INPUT_BUDGET:'1'})
    expect(result.status,result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({budget,effective,threshold})
  }
  const invalid=runAccessor({...binding,context_window_tokens:0,max_context_tokens:8192,max_output_tokens:8192},{TEST_INPUT_BUDGET:'1'})
  expect(invalid.status).not.toBe(0)
  expect(invalid.stderr).toContain('leaves no input capacity')
}, 30000)

test('actual context accessor uses exact owner 1M without USER_TYPE or provider changes', () => {
  const result = runAccessor(binding)
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ window: 1000000, oneM: true, supported: true, capacity: null })
}, 30000)

test('explicit standard suppresses opaque [1m] naming and internal context overrides', () => {
  const model = 'Vendor/Literal[1m]'
  const result = runAccessor({ ...binding, model, context_window_tokens: 0 }, {
    TEST_EXACT_MODEL: model, USER_TYPE: 'ant', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '333333',
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ window: 200000, oneM: false, supported: true, capacity: null })
}, 30000)

test('auto uses observed gateway capacity without a manual context choice or ID mapping', () => {
  for (const max_input_tokens of [128000, 262144, 1000000]) {
    const result = runAccessor({ ...binding, context_window_tokens: 0, max_input_tokens })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ window: max_input_tokens, oneM: false, supported: true, capacity: max_input_tokens })
  }
  const disabled = runAccessor({ ...binding, context_window_tokens: 0, max_input_tokens: 1000000 }, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' })
  expect(disabled.status, disabled.stderr).toBe(0)
  expect(JSON.parse(disabled.stdout)).toEqual({ window: 200000, oneM: false, supported: false, capacity: 1000000 })
}, 30000)

test('actual context accessor rejects unknown models, disabled 1M and untrusted bootstrap', () => {
  const overrides: Array<Record<string, string>> = [
    { TEST_EXACT_MODEL: 'unknown' }, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
    { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '0' },
  ]
  for (const extra of overrides) expect(runAccessor(binding, extra).status).not.toBe(0)
}, 30000)

test('unconfigured default runtime keeps its existing standard context behavior', () => {
  const result = runAccessor(undefined)
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ window: 200000, oneM: false, supported: false, capacity: null })
}, 30000)

test('actual hosted helpers, built-in agents and API normalization preserve exact frozen identity', () => {
  const model = 'Vendor/Literal[1m]'
  const result = runAccessor({ ...binding, model, context_window_tokens: 0 }, {
    TEST_EXACT_MODEL: model, TEST_FROZEN_HELPERS: '1', ANTHROPIC_SMALL_FAST_MODEL: 'foreign',
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    helpers: Array(6).fill(model), wire: model, parsed: model, agent: model,
    builtins: true, options: [model], valid: { valid: true }, rejected: 3,
  })
}, 30000)

test('actual native output budget clamps against known gateway capacity and preserves smaller requests', () => {
  for (const max_output_tokens of [4096, 8192, 65536]) {
    const result = runAccessor({ ...binding, max_output_tokens }, { TEST_OUTPUT_CAPACITY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '999999' })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ limits: { default: Math.min(32000, max_output_tokens), upperLimit: max_output_tokens }, capacity: max_output_tokens, effective: max_output_tokens })
  }
  const smaller = runAccessor({ ...binding, max_output_tokens: 8192 }, { TEST_OUTPUT_CAPACITY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1024' })
  expect(smaller.status, smaller.stderr).toBe(0)
  expect(JSON.parse(smaller.stdout).effective).toBe(1024)
}, 30000)

test('unknown hosted output capacity is not guessed from a Claude-looking ID; default path unchanged', () => {
  const model = 'claude-3-opus'
  const extra = { TEST_EXACT_MODEL: model, TEST_OUTPUT_CAPACITY: '1' }
  const custom = runAccessor({ ...binding, model }, extra)
  expect(custom.status, custom.stderr).toBe(0)
  expect(JSON.parse(custom.stdout)).toEqual({ limits: { default: 32000, upperLimit: 64000 }, capacity: null, effective: 32000 })
  const legacy = runAccessor(undefined, extra)
  expect(legacy.status, legacy.stderr).toBe(0)
  expect(JSON.parse(legacy.stdout)).toEqual({ limits: { default: 4096, upperLimit: 4096 }, capacity: null, effective: 4096 })
}, 30000)
