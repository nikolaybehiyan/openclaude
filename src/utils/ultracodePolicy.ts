import type { EffortValue } from './effort.js'

// Behavioral port of Claude Code 2.1.226 (Darwin arm64 binary SHA256
// 013a1cf17df5ff1dcc189d5d6fd3fdd5f097ddc3cd41aa9992e99805574febbe).
// Ultracode is a session flag; it is NEVER a provider effort enum value.
export type UltracodeState = { effortValue?: EffortValue; ultracode?: boolean }
export type WorkflowSettings = {
  enableWorkflows?: boolean
  disableWorkflows?: boolean
  workflowKeywordTriggerEnabled?: boolean
}

// Darb transport adapter, not a Claude 2.1.226 feature. A worker restart must
// restore a cleared effort independently of the raw Ultracode flag. Replaying
// an enable control would incorrectly force xhigh again. The Code owner emits
// this frame only from acknowledged, generation/lease-fenced session state.
export function decodeNativeReasoningRestore(value: unknown): UltracodeState | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Darb native reasoning restore state')
  }
  const frame = value as Record<string, unknown>
  const keys = Object.keys(frame)
  if (keys.length !== 3 || !keys.every(key => ['version', 'effort', 'ultracode'].includes(key)) ||
    frame.version !== 1 || typeof frame.ultracode !== 'boolean' ||
    frame.effort !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(frame.effort as string)) {
    throw new Error('Invalid Darb native reasoning restore state')
  }
  return { effortValue: frame.effort === null ? undefined : frame.effort as EffortValue, ultracode: frame.ultracode }
}

export function isUltracodeAlias(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'ultracode'
}

export function initialReasoningState(input: {
  cliEffort: unknown
  parsedCLIEffort?: EffortValue
  persistedEffort?: EffortValue
  settingsUltracode?: boolean
}): UltracodeState {
  const alias = isUltracodeAlias(input.cliEffort)
  return {
    effortValue: (alias ? 'xhigh' : input.parsedCLIEffort) ??
      (input.settingsUltracode === true ? 'xhigh' : input.persistedEffort),
    ultracode: input.settingsUltracode === true || alias,
  }
}

export function workflowAvailability(input: {
  envEnabled: boolean
  envDisabled: boolean
  gateEnabled: boolean
  subscription: string | null
}): { available: boolean; defaultOn: boolean } {
  // 2.1.226 nw_: explicit env true changes the Pro default but cannot
  // override a disabled rollout gate. env false disables availability.
  if (input.envEnabled) return { available: input.gateEnabled, defaultOn: input.gateEnabled }
  if (input.envDisabled || !input.gateEnabled) return { available: false, defaultOn: false }
  return { available: true, defaultOn: input.subscription !== 'pro' }
}

export function workflowsEnabled(input: {
  settings: WorkflowSettings
  disabledByEnv: boolean
  policyAllowed: boolean
  availability: { available: boolean; defaultOn: boolean }
}): boolean {
  // 2.1.226 Ck/Vpr: hard disable and organization policy win over opt-in.
  if (input.disabledByEnv || input.settings.disableWorkflows === true || !input.policyAllowed) return false
  if (!input.availability.available) return false
  return input.settings.enableWorkflows ?? input.availability.defaultOn
}

export function ultracodeIsActive(state: UltracodeState, enabled: boolean, appliedEffort: EffortValue | undefined): boolean {
  // 2.1.226 jQ: raw flag alone is insufficient for the active indicator.
  return state.ultracode === true && enabled && appliedEffort === 'xhigh'
}

export function applyNativeReasoningFlags<T extends UltracodeState>(
  previous: T,
  incoming: Record<string, unknown>,
  parseEffort: (value: unknown) => EffortValue | undefined,
): T {
  let next = previous
  if ('effortLevel' in incoming) {
    const effort = incoming.effortLevel == null ? undefined
      : isUltracodeAlias(incoming.effortLevel) ? 'xhigh' : parseEffort(incoming.effortLevel)
    if (incoming.effortLevel == null || effort !== undefined) next = { ...next, effortValue: effort }
    if (isUltracodeAlias(incoming.effortLevel)) next = { ...next, ultracode: true }
  }
  // Matches 2.1.226 apply_flag_settings order. Combined flags are atomic:
  // enabling Ultracode forces xhigh even if another effort was in the frame.
  if ('ultracode' in incoming) {
    const ultracode = incoming.ultracode === true
    next = { ...next, ultracode, ...(ultracode ? { effortValue: 'xhigh' as const } : {}) }
  }
  return next
}

export type KeywordMatch = { word: string; start: number; end: number }
export function findUltracodeKeyword(text: string): KeywordMatch[] {
  // 2.1.226 gfa/_fa. Quoted examples, filenames, paths and slash commands
  // must not opt a user's turn into multi-agent execution.
  if (!/ultracode/i.test(text) || text.startsWith('/')) return []
  const pairs: Record<string, string> = { '`': '`', '"': '"', '<': '>', '{': '}', '[': ']', '(': ')', "'": "'" }
  const spans: { start: number; end: number }[] = []
  const word = (char: string | undefined) => !!char && /[\p{L}\p{N}_]/u.test(char)
  let open: string | null = null, start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (open) {
      if (open === '[' && char === '[') { start = i; continue }
      if (char !== pairs[open] || open === "'" && word(text[i + 1])) continue
      spans.push({ start, end: i + 1 }); open = null
    } else if (char === '<' && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!) ||
      char === "'" && !word(text[i - 1]) || char !== '<' && char !== "'" && char in pairs) {
      open = char; start = i
    }
  }
  const result: KeywordMatch[] = []
  for (const match of text.matchAll(/\bultracode\b/gi)) {
    const start = match.index!, end = start + match[0].length
    if (spans.some(span => start >= span.start && start < span.end)) continue
    const before = text[start - 1], after = text[end]
    if (before === '/' || before === '\\' || before === '-') continue
    if (after === '/' || after === '\\' || after === '-' || after === '?') continue
    if (after === '.' && word(text[end + 1])) continue
    result.push({ word: match[0], start, end })
  }
  return result
}
