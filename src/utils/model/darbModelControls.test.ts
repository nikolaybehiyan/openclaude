import { describe, expect, test } from 'bun:test'
import { darbCanSelectEffort, darbCanSelectThinking, darbEffortOptions, darbThinkingRequest, parseDarbModelControls, parseDarbNativeThinking, parseDarbThinkingOptions, validateDarbNativeThinking, resolveDarbThinkingRequest, darbThinkingWithEffort, darbThinkingWithMode, darbThinkingModes } from './darbModelControls.js'
import { parseDarbCatalog } from './darbCatalog.js'

const contract = () => ({ version: 1, codec: 'anthropic_messages',
  thinking: { enabled: 'unknown', adaptive: 'unsupported', disabled: 'unknown' },
  effort: { support: 'unknown', values: null }, reasoning_required: null })
const dynamicContract = () => ({ ...contract(), codec: 'openai_chat_dynamic_thinking',
  thinking: { enabled: 'unsupported', adaptive: 'unknown', disabled: 'unknown' } })
const dynamicCapabilities = () => ({ reasoning: false, reasoning_support: 'unknown', thinking_types: [],
  thinking_mode_field: true, effort_support: 'unknown', parameter_contract: dynamicContract() })

describe('managed Darb control intent', () => {
  test('explicit budget extension preserves enabled budget without fabricating adaptive or combining effort', () => {
    const caps = {reasoning_support:'supported', thinking_mode_field:true, thinking_types:['enabled'],
      effort_support:'supported', parameter_contract:{...contract(),codec:'openai_chat_thinking_budget',
        thinking:{enabled:'supported',adaptive:'unsupported',disabled:'supported'},
        effort:{support:'supported',values:['none','low','xhigh']}}}
    const controls = parseDarbModelControls(caps)
    expect(darbThinkingModes(controls)).toEqual(['extended','off'])
    expect(darbThinkingRequest(controls,{type:'mode',mode:'extended'},2048,4096)).toEqual({type:'enabled',budget_tokens:2048})
    expect(darbThinkingRequest(controls,null,2048,4096)).toBeUndefined()
    expect(darbThinkingRequest(controls,{type:'mode',mode:'off'},2048,4096)).toEqual({type:'disabled'})
    expect(()=>validateDarbNativeThinking(controls,{type:'effort_and_mode',mode:'extended',effort:'low'})).toThrow('conflict')
    expect(()=>validateDarbNativeThinking(controls,{type:'effort_and_mode',mode:'off',effort:'xhigh'})).toThrow('conflict')
    expect(()=>parseDarbModelControls({...caps,thinking_mode_field:false})).toThrow()
    expect(()=>parseDarbModelControls({...caps,thinking_types:['adaptive']})).toThrow()
  })
  test('unknown remains unknown and generic reasoning does not select any thinking mode', () => {
    const unknown = parseDarbModelControls({})
    expect(unknown.reasoning_support).toBe('unknown')
    expect(unknown.effort_support).toBe('unknown')
    expect(darbCanSelectThinking(unknown, 'adaptive')).toBe(false)
    expect(darbCanSelectEffort(unknown, 'medium')).toBe(false)
    const generic = parseDarbModelControls({ reasoning: true })
    expect(generic.reasoning_support).toBe('supported')
    expect(darbCanSelectThinking(generic, 'adaptive')).toBe(false)
    expect(darbCanSelectThinking(generic, 'enabled')).toBe(false)
    expect(darbThinkingRequest(generic, null, 32000, 32001)).toBeUndefined()
  })

  test('known codec permits explicit unknown attempts without manufacturing capability facts', () => {
    const row = parseDarbModelControls({ reasoning_support: 'unknown', parameter_contract: contract() })
    expect(row.reasoning_support).toBe('unknown')
    expect(darbThinkingModes({...row,thinking:null})).toEqual([])
    expect(darbEffortOptions({...row,thinking:null})).toEqual([])
    expect(row.thinking_types).toEqual([])
    expect(darbCanSelectThinking(row, 'enabled')).toBe(true)
    expect(darbCanSelectThinking(row, 'adaptive')).toBe(false)
    expect(darbCanSelectEffort(row, 'minimal')).toBe(true)
    expect(darbEffortOptions(row)).toEqual([])
    expect(darbThinkingRequest(row, undefined, 32000, 32001)).toBeUndefined()
    expect(darbThinkingRequest(row, { type: 'mode', mode: 'extended' }, 32000, 8192)).toEqual({ type: 'enabled', budget_tokens: 8191 })
  })

  test('reset, off, enabled and adaptive remain distinct; enabled is not upgraded', () => {
    const row = parseDarbModelControls({ reasoning: true, thinking_types: ['adaptive', 'enabled'], reasoning_efforts: ['minimal', 'xhigh'] })
    expect(darbThinkingRequest(row, parseDarbNativeThinking(null), 32000, 65536)).toBeUndefined()
    expect(darbThinkingRequest(row, parseDarbNativeThinking({ type: 'mode', mode: 'off' }), 32000, 65536)).toEqual({ type: 'disabled' })
    expect(darbThinkingRequest(row, parseDarbNativeThinking({ type: 'mode', mode: 'auto' }), 32000, 65536)).toEqual({ type: 'adaptive' })
    expect(darbThinkingRequest(row, parseDarbNativeThinking({ type: 'mode', mode: 'extended' }), 32000, 65536)).toEqual({ type: 'enabled', budget_tokens: 32000 })
    expect(darbEffortOptions(row)).toEqual(['minimal', 'xhigh'])
    expect(() => darbThinkingRequest(row, { type: 'mode', mode: 'extended' }, 32000, 1024)).toThrow('budget')
  })

  test('explicit metadata denial and mandatory reasoning restrictions win', () => {
    const denied = parseDarbModelControls({ reasoning_support: 'unsupported', parameter_contract: contract() })
    expect(darbCanSelectThinking(denied, 'enabled')).toBe(false)
    expect(darbCanSelectEffort(denied, 'minimal')).toBe(false)
    const required = parseDarbModelControls({ parameter_contract: { ...contract(), reasoning_required: true } })
    expect(darbCanSelectThinking(required, 'disabled')).toBe(false)
    expect(() => validateDarbNativeThinking(required, { type: 'mode', mode: 'off' })).toThrow('unavailable')
    const noEffort = parseDarbModelControls({ effort_support: 'unsupported', parameter_contract: contract() })
    expect(darbCanSelectEffort(noEffort, 'high')).toBe(false)
  })

  test('effort values and order are exact data; empty is not null and neither selects a default', () => {
    for (const values of [[], ['none', 'minimal', 'xhigh', 'Vendor.Exact']]) {
      const row = parseDarbModelControls({ parameter_contract: { ...contract(), effort: { support: 'supported', values } } })
      expect(darbEffortOptions(row)).toEqual(values)
      expect(darbCanSelectEffort(row, 'high')).toBe(false)
      expect(darbThinkingRequest(row, null, 32000, 65536)).toBeUndefined()
      expect(Object.isFrozen(row.parameter_contract?.effort.values)).toBe(true)
    }
  })

  test('malformed contracts/state fail closed without guessing a codec or silently clamping effort', () => {
    for (const parameter_contract of [null, {}, { ...contract(), version: 2 }, { ...contract(), codec: 'guessed' }, { ...contract(), reasoning_required: undefined }, { ...contract(), effort: { support: 'unknown', values: ['high', 'high'] } }]) {
      expect(() => parseDarbModelControls({ parameter_contract })).toThrow('controls')
    }
    for (const state of [undefined, {}, { type: 'mode', mode: 'enabled' }, { type: 'effort', effort: 'high', mode: 'auto' }, { type: 'effort', effort: '\x1b[31m' }, { type: 'mode', mode: 'off', api_key: 'untrusted' }]) {
      expect(() => parseDarbNativeThinking(state)).toThrow('controls')
    }
    expect(() => validateDarbNativeThinking(parseDarbModelControls({ reasoning: true, reasoning_efforts: ['low'] }), { type: 'effort', effort: 'max' })).toThrow('unavailable')
  })

  test('owner product options filter the picker without selecting or manufacturing facts', () => {
    const facts = parseDarbModelControls({ parameter_contract: contract() })
    const thinking = parseDarbThinkingOptions({type:'effort_and_mode',mode_options:[{id:'off',name:''},{id:'extended',name:'Extended'}],effort_options:[{id:'Vendor.Exact',name:'Exact'}]},facts)
    const row = {...facts,thinking}
    expect(darbThinkingModes(row)).toEqual(['off','extended'])
    expect(darbEffortOptions(row)).toEqual(['Vendor.Exact'])
    expect(row.reasoning_support).toBe('unknown')
    expect(resolveDarbThinkingRequest(row,undefined,undefined,2048,8192)).toBeUndefined()
    expect(() => parseDarbThinkingOptions({type:'mode',mode_options:[{id:'auto',name:'Adaptive'}]},facts)).toThrow()
    expect(darbThinkingWithEffort({type:'mode',mode:'off'},'Vendor.Exact')).toEqual({type:'effort_and_mode',mode:'off',effort:'Vendor.Exact'})
    expect(darbThinkingWithMode({type:'effort',effort:'Vendor.Exact'},undefined)).toEqual({type:'effort',effort:'Vendor.Exact'})
    expect(darbThinkingWithMode({type:'mode',mode:'off'},undefined)).toBeNull()
  })

  test('the actual request resolver keeps explicit enabled/off/reset distinct and refuses adaptive guessing', () => {
    const row = parseDarbModelControls({parameter_contract:contract()})
    expect(resolveDarbThinkingRequest(row,null,undefined,2048,8192)).toBeUndefined()
    expect(resolveDarbThinkingRequest(row,undefined,undefined,2048,8192)).toBeUndefined()
    expect(resolveDarbThinkingRequest(row,{type:'mode',mode:'extended'},{type:'disabled'},2048,8192)).toEqual({type:'disabled'})
    expect(resolveDarbThinkingRequest(row,null,{type:'enabled',budgetTokens:2048},4096,8192)).toEqual({type:'enabled',budget_tokens:2048})
    expect(() => resolveDarbThinkingRequest(row,null,{type:'adaptive'},2048,8192)).toThrow('no alternative')
  })

  test('actual parsed owner input permits declared dynamic adaptive/off without asserting support or a budget mode', () => {
    const id = 'Vendor/Exact-Model', connection = 'icn_' + 'a'.repeat(32), digest = 'sha256:' + 'b'.repeat(64)
    const thinking = { type: 'effort_and_mode', mode: 'auto', effort: 'high' }
    const catalog = parseDarbCatalog(JSON.parse(JSON.stringify({ configuration_mode: 'custom', has_more: false,
      data: [{ id, display_name: 'Exact model', connection_id: connection, connection_revision: 2, catalog_revision: digest,
        capabilities: dynamicCapabilities(), thinking: { type: 'effort_and_mode',
          mode_options: [{ id: 'auto', name: 'Adaptive' }, { id: 'off', name: 'Off' }],
          effort_options: [{ id: 'high', name: 'High' }, { id: 'minimal', name: 'Minimal' }] } }],
      saved_selection: { model: id, connection_id: connection, connection_revision: 2, catalog_revision: digest },
      native_selector_state: { model: id, thinking, thinking_by_model: [{ id, thinking }] },
    })))
    if (catalog.mode !== 'custom') throw Error('Expected custom owner input')
    const row = catalog.models[0]!
    expect(row.id).toBe(id)
    expect(row.reasoning_support).toBe('unknown')
    expect(row.thinking_types).toEqual([])
    expect(row.parameter_contract?.codec).toBe('openai_chat_dynamic_thinking')
    expect(darbThinkingModes(row)).toEqual(['auto', 'off'])
    expect(darbEffortOptions(row)).toEqual(['high', 'minimal'])
    expect(darbThinkingRequest(row, row.selected_thinking, 2048, 8192)).toEqual({ type: 'adaptive' })
    expect(resolveDarbThinkingRequest(row, null, { type: 'disabled' }, 2048, 8192)).toEqual({ type: 'disabled' })
    expect(resolveDarbThinkingRequest(row, null, undefined, 2048, 8192)).toBeUndefined()
    expect(() => resolveDarbThinkingRequest(row, null, { type: 'enabled', budgetTokens: 2048 }, 2048, 8192)).toThrow('no alternative')
    expect(() => parseDarbThinkingOptions({ type: 'mode', mode_options: [{ id: 'extended', name: 'Extended' }] }, row)).toThrow('controls')
  })

  test('dynamic codec requires the explicit field declaration and compatible canonical contract', () => {
    for (const thinking_mode_field of [undefined, null, false, 'true', 1]) {
      expect(() => parseDarbModelControls({ ...dynamicCapabilities(), thinking_mode_field })).toThrow('controls')
    }
    expect(() => parseDarbModelControls({ ...dynamicCapabilities(), thinking_types: ['enabled'] })).toThrow('controls')
    for (const enabled of ['unknown', 'supported']) {
      expect(() => parseDarbModelControls({ ...dynamicCapabilities(), parameter_contract: {
        ...dynamicContract(), thinking: { ...dynamicContract().thinking, enabled },
      } })).toThrow('controls')
    }
    for (const parameter_contract of [
      { ...dynamicContract(), reasoning_required: true },
      { ...dynamicContract(), effort: { support: 'unknown', values: ['Vendor.Exact'] } },
      { ...dynamicContract(), effort: { support: 'unknown', values: ['high', 'high'] } },
      { ...dynamicContract(), effort: { support: 'unsupported', values: ['high'] } },
    ]) expect(() => parseDarbModelControls({ ...dynamicCapabilities(), parameter_contract })).toThrow('controls')
  })

  test('dynamic explicit denials and provider-required reasoning remain authoritative', () => {
    for (const status of ['unknown', 'supported', 'unsupported']) {
      const row = parseDarbModelControls({ ...dynamicCapabilities(), parameter_contract: {
        ...dynamicContract(), thinking: { enabled: 'unsupported', adaptive: status, disabled: status },
      } })
      expect(darbCanSelectThinking(row, 'adaptive')).toBe(status !== 'unsupported')
      expect(darbCanSelectThinking(row, 'disabled')).toBe(status !== 'unsupported')
      expect(darbCanSelectThinking(row, 'enabled')).toBe(false)
    }
    const denied = parseDarbModelControls({ ...dynamicCapabilities(), reasoning_support: 'unsupported' })
    expect(darbCanSelectThinking(denied, 'adaptive')).toBe(false)
    expect(darbCanSelectEffort(denied, 'high')).toBe(false)
    const noEffort = parseDarbModelControls({ ...dynamicCapabilities(), effort_support: 'unsupported' })
    expect(darbEffortOptions(noEffort)).toEqual([])
    const forcedContract = { ...dynamicContract(), reasoning_required: true,
      thinking: { enabled: 'unsupported', adaptive: 'unknown', disabled: 'unsupported' } }
    const forced = parseDarbModelControls({ ...dynamicCapabilities(), parameter_contract: forcedContract })
    expect(darbThinkingModes(forced)).toEqual(['auto'])
    expect(darbCanSelectEffort(forced, 'none')).toBe(false)
    expect(darbEffortOptions(forced)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(() => validateDarbNativeThinking(forced, { type: 'mode', mode: 'off' })).toThrow('unavailable')
    expect(() => parseDarbModelControls({ ...dynamicCapabilities(), parameter_contract: {
      ...forcedContract, effort: { support: 'unknown', values: ['none'] },
    } })).toThrow('controls')
    const providerOnly = parseDarbModelControls({ ...dynamicCapabilities(), parameter_contract: {
      ...forcedContract, thinking: { enabled: 'unsupported', adaptive: 'unsupported', disabled: 'unsupported' },
    } })
    expect(darbThinkingModes(providerOnly)).toEqual([])
    expect(darbThinkingRequest(providerOnly, null, 2048, 8192)).toBeUndefined()
  })

  test('dynamic efforts preserve exact subsets and distinguish null unknown attempts from an empty list', () => {
    const unknown = parseDarbModelControls(dynamicCapabilities())
    expect(darbEffortOptions(unknown)).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    for (const value of ['Vendor.Exact', 'HIGH', 'maximum']) expect(darbCanSelectEffort(unknown, value)).toBe(false)
    for (const values of [[], ['xhigh', 'minimal', 'none']]) {
      const row = parseDarbModelControls({ ...dynamicCapabilities(), parameter_contract: {
        ...dynamicContract(), effort: { support: 'unknown', values },
      } })
      expect(darbEffortOptions(row)).toEqual(values)
      expect(darbCanSelectEffort(row, 'high')).toBe(false)
      expect(Object.isFrozen(row.parameter_contract?.effort.values)).toBe(true)
    }
  })

  test('the existing four codecs retain their previous parsing and explicit-attempt behavior', () => {
    for (const codec of ['anthropic_messages', 'openai_chat_completions', 'openai_responses', 'router_reasoning']) {
      const row = parseDarbModelControls({ parameter_contract: { ...contract(), codec } })
      expect(row.parameter_contract?.codec).toBe(codec)
      expect(darbCanSelectThinking(row, 'enabled')).toBe(true)
      expect(darbCanSelectThinking(row, 'adaptive')).toBe(false)
      expect(darbCanSelectEffort(row, 'Vendor.Exact')).toBe(true)
      expect(darbEffortOptions(row)).toEqual([])
    }
  })
})
