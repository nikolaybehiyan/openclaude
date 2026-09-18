// Managed Darb metadata is knowledge, not a provider-name heuristic or a
// default request. The owner separately authorizes explicit protocol attempts.
export type DarbSupport = 'unknown' | 'supported' | 'unsupported'
export type DarbThinkingType = 'enabled' | 'adaptive' | 'disabled'
export type DarbNativeThinking = Readonly<{
  type: 'mode' | 'effort' | 'effort_and_mode'
  mode?: 'extended' | 'auto' | 'off'
  effort?: string
}>
export type DarbThinkingOptions = Readonly<{
  type: 'mode' | 'effort' | 'effort_and_mode'
  mode_options: readonly Readonly<{ id: 'extended' | 'auto' | 'off'; name: string }>[]
  effort_options: readonly Readonly<{ id: string; name: string }>[]
}>
export type DarbParameterContract = Readonly<{
  version: 1
  codec: 'anthropic_messages' | 'openai_chat_completions' | 'openai_chat_dynamic_thinking' | 'openai_chat_thinking_budget' | 'openai_responses' | 'router_reasoning'
  thinking: Readonly<Record<DarbThinkingType, DarbSupport>>
  effort: Readonly<{ support: DarbSupport; values: readonly string[] | null }>
  reasoning_required: boolean | null
}>
export type DarbModelControls = Readonly<{
  reasoning_support: DarbSupport
  thinking_types: readonly Exclude<DarbThinkingType, 'disabled'>[]
  effort_support: DarbSupport
  reasoning_efforts: readonly string[]
  parameter_contract?: DarbParameterContract
  // Owner product options are separate from facts and protocol permission.
  thinking?: DarbThinkingOptions | null
}>

function invalid(): never { throw new Error('Invalid Darb reasoning controls') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
export function isDarbEffort(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/.test(value)
}
function support(value: unknown, legacy?: unknown): DarbSupport {
  if (value === undefined) return legacy === true ? 'supported' : legacy === false ? 'unsupported' : 'unknown'
  if (value !== 'supported' && value !== 'unsupported' && value !== 'unknown') return invalid()
  return value
}
function efforts(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(v => !isDarbEffort(v)) || new Set(value).size !== value.length) return invalid()
  return Object.freeze([...value])
}
const dynamicThinkingEfforts = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export function parseDarbModelControls(value: unknown): DarbModelControls {
  const row = value == null ? {} : record(value)
  if (row.reasoning !== undefined && typeof row.reasoning !== 'boolean') return invalid()
  const types = row.thinking_types ?? []
  if (!Array.isArray(types) || types.some(v => v !== 'enabled' && v !== 'adaptive') || new Set(types).size !== types.length) return invalid()
  const reasoning_support = support(row.reasoning_support, row.reasoning)
  const effort_support = support(row.effort_support)
  const reasoning_efforts = efforts(row.reasoning_efforts ?? [])
  let contract: DarbParameterContract | undefined
  if (row.parameter_contract !== undefined) {
    const c = record(row.parameter_contract), thinking = record(c.thinking), effort = record(c.effort)
    if (c.version !== 1 || !['anthropic_messages', 'openai_chat_completions', 'openai_chat_dynamic_thinking', 'openai_chat_thinking_budget', 'openai_responses', 'router_reasoning'].includes(c.codec as string) ||
        (c.reasoning_required !== null && typeof c.reasoning_required !== 'boolean') ||
        ['enabled', 'adaptive', 'disabled'].some(key => thinking[key] === undefined) || effort.support === undefined || effort.values === undefined) return invalid()
    contract = Object.freeze({ version: 1, codec: c.codec as DarbParameterContract['codec'],
      thinking: Object.freeze({ enabled: support(thinking.enabled), adaptive: support(thinking.adaptive), disabled: support(thinking.disabled) }),
      effort: Object.freeze({ support: support(effort.support), values: effort.values === null ? null : efforts(effort.values) }),
      reasoning_required: c.reasoning_required as boolean | null })
    if (contract.codec === 'openai_chat_thinking_budget') {
      if (row.thinking_mode_field !== true || contract.thinking.adaptive !== 'unsupported' || types.includes('adaptive') ||
          contract.reasoning_required === true && contract.thinking.disabled !== 'unsupported' ||
          contract.effort.support === 'unsupported' && (contract.effort.values?.length ?? 0) > 0 ||
          contract.effort.values?.some(value => !dynamicThinkingEfforts.includes(value) || value === 'none' && contract.reasoning_required === true)) return invalid()
    }
    if (contract.codec === 'openai_chat_dynamic_thinking') {
      // This extension is an explicit owner declaration, never inferred from
      // a model name or ordinary Chat compatibility. It has no budget mode.
      if (row.thinking_mode_field !== true || contract.thinking.enabled !== 'unsupported' || types.includes('enabled') ||
          contract.reasoning_required === true && contract.thinking.disabled !== 'unsupported' ||
          contract.effort.support === 'unsupported' && (contract.effort.values?.length ?? 0) > 0 ||
          contract.effort.values?.some(value => !dynamicThinkingEfforts.includes(value) || value === 'none' && contract.reasoning_required === true)) return invalid()
    }
  }
  return Object.freeze({ reasoning_support, effort_support, reasoning_efforts,
    thinking_types: Object.freeze([...types]) as DarbModelControls['thinking_types'],
    ...(contract ? { parameter_contract: contract } : {}) })
}

export function parseDarbNativeThinking(value: unknown): DarbNativeThinking | null {
  if (value === null) return null
  const row = record(value)
  if (!['mode', 'effort', 'effort_and_mode'].includes(row.type as string) ||
      Object.keys(row).some(key => !['type', 'mode', 'effort'].includes(key))) return invalid()
  const hasMode = row.type !== 'effort', hasEffort = row.type !== 'mode'
  if (hasMode ? !['extended', 'auto', 'off'].includes(row.mode as string) : row.mode !== undefined) return invalid()
  if (hasEffort ? !isDarbEffort(row.effort) : row.effort !== undefined) return invalid()
  return Object.freeze({ type: row.type as DarbNativeThinking['type'],
    ...(hasMode ? { mode: row.mode as DarbNativeThinking['mode'] } : {}),
    ...(hasEffort ? { effort: row.effort as string } : {}) })
}

export function parseDarbThinkingOptions(value: unknown, controls: DarbModelControls): DarbThinkingOptions | null | undefined {
  if (value === undefined || value === null) return value
  const row = record(value)
  if (!['mode', 'effort', 'effort_and_mode'].includes(row.type as string)) return invalid()
  const parse = (value: unknown, mode: boolean) => {
    if (value === undefined) return Object.freeze([])
    if (!Array.isArray(value) || value.length > 64) return invalid()
    const seen = new Set<string>()
    return Object.freeze(value.map(value => {
      const option = record(value)
      if (typeof option.id !== 'string' || seen.has(option.id) || typeof option.name !== 'string' || option.name.length > 512 || /[\p{Cc}]/u.test(option.name)) return invalid()
      if (mode ? !['extended', 'auto', 'off'].includes(option.id) : !isDarbEffort(option.id)) return invalid()
      if (mode ? !darbCanSelectThinking(controls, option.id === 'extended' ? 'enabled' : option.id === 'auto' ? 'adaptive' : 'disabled') : !darbCanSelectEffort(controls, option.id)) return invalid()
      seen.add(option.id)
      return Object.freeze({ id: option.id, name: option.name })
    }))
  }
  const mode_options = parse(row.mode_options, true), effort_options = parse(row.effort_options, false)
  if (row.type === 'mode' && effort_options.length || row.type === 'effort' && mode_options.length) return invalid()
  return Object.freeze({ type: row.type as DarbThinkingOptions['type'], mode_options: mode_options as DarbThinkingOptions['mode_options'], effort_options })
}

export function darbCanSelectThinking(controls: DarbModelControls, type: DarbThinkingType): boolean {
  const contract = controls.parameter_contract
  if (type === 'enabled' && contract?.codec === 'openai_chat_dynamic_thinking') return false
  if (type === 'adaptive' && contract?.codec === 'openai_chat_thinking_budget') return false
  if (type === 'disabled' && contract?.reasoning_required === true) return false
  if (type !== 'disabled' && controls.reasoning_support === 'unsupported') return false
  if (contract) return contract.thinking[type] !== 'unsupported'
  // Legacy positive metadata permits only the declared mode, never
  // reasoning=true -> adaptive (or an invented enabled budget).
  return type === 'disabled' ? controls.thinking_types.length > 0 : controls.thinking_types.includes(type)
}

export function darbCanSelectEffort(controls: DarbModelControls, value: string): boolean {
  if (!isDarbEffort(value) || controls.reasoning_support === 'unsupported' || controls.effort_support === 'unsupported') return false
  const contract = controls.parameter_contract
  if ((contract?.codec === 'openai_chat_dynamic_thinking' || contract?.codec === 'openai_chat_thinking_budget') &&
      (!dynamicThinkingEfforts.includes(value) || value === 'none' && contract.reasoning_required === true)) return false
  if (contract) return contract.effort.support !== 'unsupported' && (contract.effort.values === null || contract.effort.values.includes(value))
  return controls.reasoning_efforts.includes(value)
}

export function darbEffortOptions(controls: DarbModelControls): readonly string[] {
  const contract = controls.parameter_contract
  const values = controls.thinking !== undefined ? controls.thinking?.effort_options.map(row => row.id) ?? []
    : contract?.codec === 'openai_chat_dynamic_thinking' || contract?.codec === 'openai_chat_thinking_budget' ? contract.effort.values ?? dynamicThinkingEfforts
    : contract?.effort.values ?? controls.reasoning_efforts
  return values.filter(value => darbCanSelectEffort(controls, value))
}

export function darbThinkingWithEffort(selected: DarbNativeThinking | null | undefined, effort: string | undefined): DarbNativeThinking | null {
  return parseDarbNativeThinking(selected?.mode
    ? { type: effort === undefined ? 'mode' : 'effort_and_mode', mode: selected.mode, ...(effort === undefined ? {} : { effort }) }
    : effort === undefined ? null : { type: 'effort', effort })
}

export function darbThinkingModes(controls: DarbModelControls): readonly NonNullable<DarbNativeThinking['mode']>[] {
  if (controls.thinking !== undefined) return controls.thinking?.mode_options.map(row => row.id) ?? []
  return (['extended', 'auto', 'off'] as const).filter(mode => darbCanSelectThinking(controls, mode === 'extended' ? 'enabled' : mode === 'auto' ? 'adaptive' : 'disabled'))
}

export function darbThinkingWithMode(selected: DarbNativeThinking | null | undefined, mode: DarbNativeThinking['mode']): DarbNativeThinking | null {
  return parseDarbNativeThinking(mode === undefined
    ? selected?.effort === undefined ? null : { type: 'effort', effort: selected.effort }
    : { type: selected?.effort === undefined ? 'mode' : 'effort_and_mode', mode, ...(selected?.effort === undefined ? {} : { effort: selected.effort }) })
}

export function validateDarbNativeThinking(controls: DarbModelControls, value: DarbNativeThinking | null): void {
  if (value === null) return
  const mode = value.mode === 'extended' ? 'enabled' : value.mode === 'auto' ? 'adaptive' : value.mode === 'off' ? 'disabled' : undefined
  if (mode && !darbCanSelectThinking(controls, mode) || value.effort !== undefined && !darbCanSelectEffort(controls, value.effort)) {
    throw new Error('Darb selected reasoning controls are unavailable; refresh the model selection')
  }
  if (controls.parameter_contract?.codec === 'openai_chat_thinking_budget' && value.effort !== undefined &&
      (mode === 'enabled' || mode === 'disabled' && value.effort !== 'none')) {
    throw new Error('Darb selected reasoning controls conflict; use a thinking budget or effort, not both')
  }
}

// Reset is an absent optional field, not off; the budget belongs to the caller's
// existing runtime policy, not to a model-name table or this catalog decoder.
export function darbThinkingRequest(controls: DarbModelControls, selected: DarbNativeThinking | null | undefined, budget: number, maxOutput: number) {
  if (selected == null) return undefined
  validateDarbNativeThinking(controls, selected)
  if (selected.mode === undefined) return undefined
  if (selected.mode === 'off') return { type: 'disabled' as const }
  if (selected.mode === 'auto') return { type: 'adaptive' as const }
  const bounded = Math.min(budget, maxOutput - 1)
  if (!Number.isSafeInteger(budget) || !Number.isSafeInteger(maxOutput) || bounded < 1024) throw new Error('Darb enabled thinking requires a valid runtime budget below max output')
  return { type: 'enabled' as const, budget_tokens: bounded }
}

export function resolveDarbThinkingRequest(controls: DarbModelControls, selected: DarbNativeThinking | null | undefined,
  explicit: { type: 'disabled' } | { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | undefined,
  budget: number, maxOutput: number) {
  if (!explicit) return darbThinkingRequest(controls, selected, budget, maxOutput)
  if (!darbCanSelectThinking(controls, explicit.type)) throw new Error('Darb selected thinking mode is unavailable; no alternative mode was used')
  if (explicit.type === 'disabled') return { type: 'disabled' as const }
  if (explicit.type === 'adaptive') return { type: 'adaptive' as const }
  return darbThinkingRequest(controls, { type: 'mode', mode: 'extended' }, explicit.budgetTokens, maxOutput)
}
