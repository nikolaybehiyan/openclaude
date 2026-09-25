import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const oldEnv = { ...process.env }
const originalConfig = await import('../config.js')
const originalProviders = await import('./providers.js')
const originalSettings = await import('../settings/settings.js')
const config = { oauthAccount: { accountUuid: 'account-A', organizationUuid: 'org-A' } }
let provider = 'firstParty'
let settings: { model?: string, availableModels?: string[] } = {}
mock.module('../config.js', () => ({ ...originalConfig, getGlobalConfig: () => config }))
mock.module('./providers.js', () => ({ ...originalProviders, getAPIProvider: () => provider }))
mock.module('../settings/settings.js', () => ({
  ...originalSettings,
  getSettings_DEPRECATED: () => settings,
  getInitialSettings: () => settings,
  getSettingsWithErrors: () => ({ settings, errors: [] }),
}))
const managed = await import('./darbModels.js')
const model = await import('./model.js')
const { isModelAllowed } = await import('./modelAllowlist.js')
const { getModelOptions } = await import('./modelOptions.js')
const { getAvailableEffortLevels, modelSupportsEffort, modelSupportsMaxEffort } = await import('../effort.js')
const { modelSupportsThinking, modelSupportsAdaptiveThinking } = await import('../thinking.js')
const { getAgentModel, getAgentModelOptions } = await import('./agent.js')
const { setMainLoopModelOverride } = await import('../../bootstrap/state.js')
const { getContextWindowForModel, getKnownDarbModelInputCapacity, getKnownDarbModelOutputCapacity } = await import('../context.js')

function install(id = 'Vendor/DeepSeek-V3[1m]', status = 'ready') {
  const scope = managed.darbModelScope()!
  const version = managed.darbCatalogSession.begin(scope)
  const binding = { connection_id: 'icn_' + 'a'.repeat(32), connection_revision: 4, catalog_revision: 'sha256:' + 'b'.repeat(64) }
  managed.darbCatalogSession.complete(scope, version, {
    configuration_mode:'custom', status,
    data: [{ ...binding, id, display_name: 'Real model', capabilities: { reasoning: true, reasoning_efforts: ['medium', 'xhigh'] } }],
    saved_selection: { ...binding, model: id }, has_more: false,
  })
}

function installDefault() {
  const scope=managed.darbModelScope()!,version=managed.darbCatalogSession.begin(scope)
  managed.darbCatalogSession.complete(scope,version,{configuration_mode:'default',data:[{id:'claude-sonnet-4-6',type:'model',display_name:'Sonnet 4.6'}],has_more:false,first_id:'claude-sonnet-4-6',last_id:'claude-sonnet-4-6'})
}

beforeEach(() => {
  provider = 'firstParty'
  settings = {}
  setMainLoopModelOverride(undefined)
  config.oauthAccount = { accountUuid: 'account-A', organizationUuid: 'org-A' }
  process.env.DARB_CLI_MANAGED_INFERENCE = '1'
  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
  process.env.ANTHROPIC_BASE_URL = 'https://ai.darbmind.ru'
  delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  delete process.env.ANTHROPIC_MODEL
  install()
})

afterAll(() => {
  settings = {}
  mock.restore()
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
  Object.assign(process.env, oldEnv)
})

describe('Darb CLI model consumers', () => {
  test('default owner metadata updates budgets and native controls without entering BYOK mode', () => {
    const scope=managed.darbModelScope()!, version=managed.darbCatalogSession.begin(scope)
    managed.darbCatalogSession.complete(scope,version,{configuration_mode:'default',has_more:false,data:[{
      id:'claude-sonnet-4-6',type:'model',display_name:'GLM-5.3',
      max_context_tokens:1048576,max_input_tokens:1048576,max_output_tokens:131072,
      native_parameters:{version:1,thinking_types:['enabled'],effort_values:['low','high','max']},
    }]})
    expect(managed.isDarbCustomInference()).toBe(false)
    expect(getContextWindowForModel('claude-sonnet-4-6')).toBe(1048576)
    expect(getKnownDarbModelInputCapacity('claude-sonnet-4-6')).toBe(1048576)
    expect(getKnownDarbModelOutputCapacity('claude-sonnet-4-6')).toBe(131072)
    expect(modelSupportsAdaptiveThinking('claude-sonnet-4-6')).toBe(false)
    expect(getAvailableEffortLevels('claude-sonnet-4-6')).toEqual(['low','high','max'])
    expect(getContextWindowForModel('claude-sonnet-4-6[1m]')).toBe(1048576)
    expect(getAvailableEffortLevels('claude-sonnet-4-6[1m]')).toEqual(['low','high','max'])
    expect(managed.currentDarbDefaultModel('claude-sonnet-4-6[1m]-other')).toBeUndefined()
    config.oauthAccount.organizationUuid='org-B'
    expect(managed.currentDarbDefaultModel('claude-sonnet-4-6')).toBeUndefined()
  })
  test('changed catalog allows selection candidates without authorizing inference or agents', () => {
    install('Vendor/Exact','selection_required')
    expect(managed.requireDarbModelCandidate('Vendor/Exact').id).toBe('Vendor/Exact')
    expect(getModelOptions().map(row=>row.value)).toContain('Vendor/Exact')
    expect(()=>managed.requireDarbModel('Vendor/Exact')).toThrow('select the model again')
    expect(()=>managed.requireDarbModelCandidate('foreign')).toThrow('Connect AI')
    install('Vendor/Exact')
    expect(managed.requireDarbModel('Vendor/Exact').id).toBe('Vendor/Exact')
  })
  test('authenticated explicit default restores unchanged native aliases, options, capabilities and local policy', () => {
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    const native = () => ({
      model:model.getDefaultMainLoopModel(),fast:model.getSmallFastModel(),
      sonnet:model.parseUserSpecifiedModel('sonnet'),haiku:model.parseUserSpecifiedModel('haiku'),
      options:getModelOptions(),agents:getAgentModelOptions(),
      effort:getAvailableEffortLevels('claude-sonnet-4-6'),thinking:modelSupportsThinking('claude-sonnet-4-6'),
      allowed:isModelAllowed('claude-sonnet-4-6'),denied:isModelAllowed('claude-opus-4-6'),
    })
    settings.availableModels=['sonnet','haiku']
    process.env.DARB_CLI_MANAGED_INFERENCE='0'
    const baseline=native()
    process.env.DARB_CLI_MANAGED_INFERENCE='1'
    installDefault()
    expect(managed.isDarbManagedInference()).toBe(true)
    expect(managed.isDarbCustomInference()).toBe(false)
    expect(native()).toEqual(baseline)
    expect(baseline.allowed).toBe(true);expect(baseline.denied).toBe(false)
    expect(() => managed.requireDarbModel('claude-sonnet-4-6')).toThrow('Connect AI')
    config.oauthAccount.accountUuid='account-B'
    expect(managed.isDarbCustomInference()).toBe(true)
    expect(getModelOptions()).toEqual([])
  })

  test('actual Agent tool schema follows default/custom mode changes without a stale one-shot schema',async()=>{
    const {inputSchema}=await import('../../tools/AgentTool/AgentTool.js')
    const value='Vendor/Exact'
    expect(inputSchema().shape.model.safeParse(value).success).toBe(true)
    installDefault()
    expect(inputSchema().shape.model.safeParse('sonnet').success).toBe(true)
    expect(inputSchema().shape.model.safeParse(value).success).toBe(false)
    install(value)
    expect(inputSchema().shape.model.safeParse(value).success).toBe(true)
  })
  test('main, fast and quality helpers all use the approved real model', () => {
    for (const getter of [model.getDefaultMainLoopModel, model.getSmallFastModel,
      model.getDefaultSonnetModel, model.getDefaultHaikuModel, model.getDefaultOpusModel]) {
      expect(getter()).toBe('Vendor/DeepSeek-V3[1m]')
    }
    expect(model.normalizeModelStringForAPI('Vendor/DeepSeek-V3[1m]')).toBe('Vendor/DeepSeek-V3[1m]')
    expect(getModelOptions()).toHaveLength(1)
    expect(getModelOptions()[0]?.value).toBe('Vendor/DeepSeek-V3[1m]')
  })

  test('startup ignores a stale saved native alias without changing explicit overrides or default settings', () => {
    settings.model = 'opus[1m]'
    expect(model.getUserSpecifiedModelSetting()).toBeUndefined()
    expect(model.getMainLoopModel()).toBe('Vendor/DeepSeek-V3[1m]')
    expect(settings.model).toBe('opus[1m]')
    process.env.ANTHROPIC_MODEL = 'explicit-missing-model'
    expect(model.getUserSpecifiedModelSetting()).toBe('explicit-missing-model')
    delete process.env.ANTHROPIC_MODEL
    setMainLoopModelOverride('explicit-cli-model')
    expect(model.getUserSpecifiedModelSetting()).toBe('explicit-cli-model')
    setMainLoopModelOverride(undefined)
    settings.model = 'Vendor/DeepSeek-V3[1m]'
    expect(model.getUserSpecifiedModelSetting()).toBe(settings.model)
    settings.model = 'opus[1m]'
    installDefault()
    expect(model.getUserSpecifiedModelSetting()).toBe('opus[1m]')
  })

  test('no Sonnet/Opus aliases, environment helper override or model-name reasoning inference', () => {
    install('sonnet')
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'not-authorized'
    expect(model.parseUserSpecifiedModel('sonnet')).toBe('sonnet')
    expect(model.getSmallFastModel()).toBe('sonnet')
    expect(getAvailableEffortLevels('sonnet')).toEqual(['medium', 'xhigh'])
    expect(modelSupportsEffort('sonnet')).toBe(true)
    expect(modelSupportsMaxEffort('sonnet')).toBe(false)
    // A generic factual reasoning flag is not an adaptive/enabled contract.
    expect(modelSupportsThinking('sonnet')).toBe(false)
    expect(modelSupportsAdaptiveThinking('sonnet')).toBe(false)
    expect(modelSupportsEffort('unknown-model')).toBe(false)
    expect(modelSupportsThinking('unknown-model')).toBe(false)
  })

  test('logout/account/organization switches discard the visible and execution catalog', () => {
    config.oauthAccount.accountUuid = 'account-B'
    expect(model.getDefaultMainLoopModel()).toBe('')
    expect(model.modelDisplayString(null)).toBe('Connect AI')
    expect(getModelOptions()).toEqual([])
    expect(() => managed.requireDarbModel('Vendor/DeepSeek-V3[1m]')).toThrow('Connect AI')
    config.oauthAccount.accountUuid = 'account-A'
    config.oauthAccount.organizationUuid = 'org-B'
    expect(getModelOptions()).toEqual([])
  })

  test('budget readers survive missing and refreshing models without authorizing them or inventing capacities', async () => {
    const context = await import('../context.js')
    const { calculateTokenWarningState } = await import('../../services/compact/autoCompact.js')
    const missing = ['opus[1m]', 'claude-opus-4-6', 'removed/model', '']
    const check = () => {
      for (const id of missing) {
        expect(context.getKnownDarbModelContextCapacity(id)).toBeNull()
        expect(context.getKnownDarbModelInputCapacity(id)).toBeNull()
        expect(context.getKnownDarbModelOutputCapacity(id)).toBeNull()
        expect(context.getContextWindowForModel(id)).toBe(200_000)
        expect(context.getModelMaxOutputTokens(id)).toEqual({ default: 32_000, upperLimit: 64_000 })
        expect(context.has1mContext(id)).toBe(false)
        expect(context.modelSupports1M(id)).toBe(false)
        expect(calculateTokenWarningState(0, id).percentLeft).toBe(100)
        expect(() => managed.requireDarbModel(id)).toThrow('Connect AI')
      }
    }
    check()
    // The real refresh/save path invalidates the authorization catalog while
    // its HTTP request is pending; a concurrent Notifications render is safe.
    managed.darbCatalogSession.begin(managed.darbModelScope()!)
    check()
    expect(getModelOptions()).toEqual([])
    config.oauthAccount.accountUuid = 'account-B'
    check()
  })

  test('local allowlists are exact real IDs, not Claude family/prefix remapping', () => {
    settings.availableModels = ['Vendor/DeepSeek-V3[1m]']
    expect(isModelAllowed('Vendor/DeepSeek-V3[1m]')).toBe(true)
    expect(isModelAllowed('vendor/deepseek-v3[1m]')).toBe(false)
    expect(isModelAllowed('Vendor/DeepSeek-V3[1m]-other')).toBe(false)
  })

  test('embedded runtimes and third-party profiles do not enter account CLI routing', () => {
    process.env.CLAUDE_CODE_REMOTE_SESSION_ID = 'frozen-chat-turn'
    expect(managed.isDarbManagedInference()).toBe(false)
    delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'desktop'
    expect(managed.isDarbManagedInference()).toBe(false)
    delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    provider = 'openai'
    expect(managed.isDarbManagedInference()).toBe(false)
  })

  test('an actual frozen host binding excludes standalone routing even if managed launcher flags remain set',()=>{
    const path=new URL('./darbFrozenContext.ts',import.meta.url).pathname
    const managedPath=new URL('./darbModels.ts',import.meta.url).pathname
    const frozen={owner:'identity-org-service',organization_uuid:'org-A',account_uuid:'account-A',connection_id:'icn_'+'a'.repeat(32),connection_revision:1,catalog_revision:'sha256:'+'b'.repeat(64),model:'Frozen/Exact[1m]',supports_1m:false,context_window_tokens:0}
    const child=Bun.spawnSync([process.execPath,'-e',`import {configureDarbFrozenModelContext} from ${JSON.stringify(path)};import {isDarbManagedInference,darbModelScope} from ${JSON.stringify(managedPath)};configureDarbFrozenModelContext(${JSON.stringify(frozen)});if(isDarbManagedInference()||darbModelScope()!==undefined)process.exit(1);`],{cwd:process.cwd(),env:{...process.env,DARB_CLI_MANAGED_INFERENCE:'1',CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:'1',CLAUDE_CODE_CUSTOM_OAUTH_URL:'https://ai.darbmind.ru',ANTHROPIC_BASE_URL:'https://ai.darbmind.ru'},stdout:'pipe',stderr:'pipe'})
    expect(child.stderr.toString()).toBe('');expect(child.exitCode).toBe(0)
  },30000)

  test('agents inherit a real parent model, accept exact catalog IDs and refuse fake tiers', () => {
    const id = 'Vendor/DeepSeek-V3[1m]'
    expect(getAgentModel('inherit', id)).toBe(id)
    expect(getAgentModel(id, id)).toBe(id)
    expect(() => getAgentModel('haiku', id)).toThrow('Connect AI')
    expect(getAgentModelOptions().map(row => row.value)).toEqual(['inherit', id])
    expect(model.getRuntimeMainLoopModel({ permissionMode: 'plan', mainLoopModel: id })).toBe(id)
  })

  test('agent policy cannot substitute a different custom binding or weaken exact allowlist IDs', () => {
    const id = 'Vendor/DeepSeek-V3[1m]'
    settings.availableModels = [id]
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherit'
    expect(getAgentModel('haiku', id, id)).toBe(id)
    expect(() => getAgentModel('inherit', id, 'vendor/deepseek-v3[1m]')).toThrow()
    settings.availableModels = ['vendor/deepseek-v3[1m]']
    expect(() => getAgentModel('inherit', id)).toThrow('restricted')
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  })
})
