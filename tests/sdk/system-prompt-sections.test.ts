import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { SDKControlInitializeRequestSchema } from '../../src/entrypoints/sdk/controlSchemas.js'
import { selectSystemPromptSections } from '../../src/utils/systemPromptType.js'

// Reference: preserved official 2.1.221 initialize schema + prompt selector.
// The wire sends string[]; legacy OpenClaude callers may still send strings.
describe('2.1.221 multipart system prompt compatibility', () => {
  for (const value of ['LOCAL_BASE', ['LOCAL_BASE', 'CACHE_BOUNDARY', 'LOCAL_DYNAMIC'], '', []]) {
    test(`initialize accepts ${JSON.stringify(value)}`, () => {
      const parsed = SDKControlInitializeRequestSchema().parse({
        subtype: 'initialize', systemPrompt: value, appendSystemPrompt: 'PROJECT',
      })
      expect(parsed.systemPrompt).toEqual(value)
      const sections = selectSystemPromptSections(parsed.systemPrompt, ['CODE_DEFAULT'])
      expect(sections).toEqual(typeof value === 'string' ? [value] : value)
      expect(sections.every(section => typeof section === 'string')).toBe(true)
    })
  }

  for (const invalid of [null, 17, ['valid', 17], [['nested']], { text: 'prompt' }]) {
    test(`initialize rejects malformed sections ${JSON.stringify(invalid)}`, () => {
      expect(SDKControlInitializeRequestSchema().safeParse({
        subtype: 'initialize', systemPrompt: invalid,
      }).success).toBe(false)
    })
  }

  test('absent custom prompt retains the ordinary Code default', () => {
    expect(selectSystemPromptSections(undefined, ['CODE_DEFAULT'])).toEqual(['CODE_DEFAULT'])
  })

  test('actual prompt assembly and side-question fallback preserve sections', () => {
    // Isolate mocks from the rest of the SDK suite. No provider calls or build.
    const script = `
      import { mock } from 'bun:test';
      import assert from 'node:assert/strict';
      mock.module('./src/services/analytics/index.js', () => ({ logEvent() {} }));
      mock.module('./src/tools/AgentTool/loadAgentsDir.js', () => ({ isBuiltInAgent: () => false }));
      mock.module('./src/utils/envUtils.js', () => ({ isEnvTruthy: () => false }));
      let defaultCalls = 0, systemCalls = 0;
      mock.module('./src/constants/prompts.js', () => ({ getSystemPrompt: async () => { defaultCalls++; return ['CODE_DEFAULT']; } }));
      mock.module('./src/context.js', () => ({
        getUserContext: async () => ({ user: 'ACCOUNT' }),
        getSystemContext: async () => { systemCalls++; return { system: 'CODE_ENV' }; },
      }));
      mock.module('./src/utils/abortController.js', () => ({ createAbortController: () => new AbortController() }));
      mock.module('./src/utils/model/model.js', () => ({ getMainLoopModel: () => 'test-model' }));
      mock.module('./src/utils/thinking.js', () => ({ shouldEnableThinkingByDefault: () => false }));
      const { buildEffectiveSystemPrompt } = await import('./src/utils/systemPrompt.ts');
      const { fetchSystemPromptParts, buildSideQuestionFallbackParams } = await import('./src/utils/queryContext.ts');
      const common = { tools: [], mainLoopModel: 'test-model', additionalWorkingDirectories: [], mcpClients: [] };
      for (const custom of [undefined, '', [], 'LOCAL_BASE', ['LOCAL_BASE', 'CACHE_BOUNDARY', 'LOCAL_DYNAMIC']]) {
        const beforeDefault = defaultCalls, beforeSystem = systemCalls;
        const original = JSON.stringify(custom);
        const parts = await fetchSystemPromptParts({ ...common, customSystemPrompt: custom });
        assert.equal(defaultCalls - beforeDefault, custom === undefined ? 1 : 0);
        assert.equal(systemCalls - beforeSystem, custom === undefined ? 1 : 0);
        assert.deepEqual(parts.userContext, { user: 'ACCOUNT' });
        const expected = [...(typeof custom === 'string' ? [custom] : custom ?? ['CODE_DEFAULT']), 'PROJECT'];
        const input = { mainThreadAgentDefinition: undefined, toolUseContext: { options: {} }, customSystemPrompt: custom, defaultSystemPrompt: parts.defaultSystemPrompt, appendSystemPrompt: 'PROJECT' };
        const actual = buildEffectiveSystemPrompt(input);
        assert.deepEqual(actual, expected);
        assert(actual.every(section => typeof section === 'string'));
        assert.equal(JSON.stringify(custom), original);
        assert.deepEqual(buildEffectiveSystemPrompt({ ...input, overrideSystemPrompt: 'OVERRIDE' }), ['OVERRIDE']);
        assert.deepEqual(buildEffectiveSystemPrompt({ ...input, mainThreadAgentDefinition: { getSystemPrompt: () => 'AGENT' } }), ['AGENT', 'PROJECT']);
        const side = await buildSideQuestionFallbackParams({
          ...common, commands: [], messages: [], readFileState: {},
          getAppState: () => ({ toolPermissionContext: { additionalWorkingDirectories: new Map() } }),
          setAppState() {}, customSystemPrompt: custom, appendSystemPrompt: 'PROJECT',
          thinkingConfig: undefined, agents: [],
        });
        assert.deepEqual(side.systemPrompt, expected);
      }
      console.log('multipart-assembly-pass');
    `
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: new URL('../..', import.meta.url), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, USER_TYPE: 'external', CLAUDE_CODE_COORDINATOR_MODE: '0' },
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('multipart-assembly-pass')
  })
})
