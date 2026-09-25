import { expect, test } from 'bun:test'
import { applyNativeReasoningFlags, decodeNativeReasoningRestore, findUltracodeKeyword, initialReasoningState, isUltracodeAlias, ultracodeIsActive, workflowAvailability, workflowsEnabled } from './ultracodePolicy.js'

const parse = (value: unknown) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(value as string) ? value as 'high' : undefined

test('Darb: restart preserves null effort independently of raw Ultracode', () => {
  expect(decodeNativeReasoningRestore(undefined)).toBeUndefined()
  for (const effort of [null, 'low', 'medium', 'high', 'xhigh', 'max']) {
    for (const ultracode of [false, true]) {
      expect(decodeNativeReasoningRestore({version: 1, effort, ultracode})).toEqual({effortValue: effort ?? undefined, ultracode})
    }
  }
})
test('Darb: malformed restore fails closed instead of starting on another effort', () => {
  for (const value of [null, false, [], 'xhigh', {}, {version: 2, effort: null, ultracode: true},
    {version: 1, ultracode: true}, {version: 1, effort: null}, {version: 1, effort: null, ultracode: 'true'},
    {version: 1, effort: 5, ultracode: true}, {version: 1, effort: 'ultracode', ultracode: true},
    {version: 1, effort: null, ultracode: true, other: false}]) {
    expect(() => decodeNativeReasoningRestore(value)).toThrow('Invalid Darb native reasoning restore state')
  }
})

test('226: startup explicit effort wins over raw Ultracode, unlike a new enable control', () => {
  expect(initialReasoningState({ cliEffort: 'low', parsedCLIEffort: 'low', settingsUltracode: true })).toEqual({ effortValue: 'low', ultracode: true })
  expect(initialReasoningState({ cliEffort: undefined, settingsUltracode: true, persistedEffort: 'high' })).toEqual({ effortValue: 'xhigh', ultracode: true })
  expect(initialReasoningState({ cliEffort: undefined, persistedEffort: 'high' })).toEqual({ effortValue: 'high', ultracode: false })
  expect(initialReasoningState({ cliEffort: 'Ultracode', persistedEffort: 'low' })).toEqual({ effortValue: 'xhigh', ultracode: true })
})

test('226: Ultracode is an alias plus a session flag, not a sixth effort', () => {
  expect(isUltracodeAlias(' ULTRACODE ')).toBe(true)
  expect(isUltracodeAlias('ultra')).toBe(false)
  expect(applyNativeReasoningFlags({}, { effortLevel: 'ultracode' }, parse)).toEqual({ effortValue: 'xhigh', ultracode: true })
})
test('226: combined flags, reset and disable preserve native ordering', () => {
  const active = applyNativeReasoningFlags({ effortValue: 'high' as const }, { effortLevel: 'low', ultracode: true }, parse)
  expect(active).toEqual({ effortValue: 'xhigh', ultracode: true })
  expect(applyNativeReasoningFlags(active, { effortLevel: null, ultracode: false }, parse)).toEqual({ effortValue: undefined, ultracode: false })
  expect(applyNativeReasoningFlags(active, { ultracode: false }, parse)).toEqual({ effortValue: 'xhigh', ultracode: false })
  expect(applyNativeReasoningFlags(active, { effortLevel: 'low' }, parse)).toEqual({ effortValue: 'low', ultracode: true })
  expect(applyNativeReasoningFlags(active, { effortLevel: 'invalid' }, parse)).toEqual(active)
  expect(applyNativeReasoningFlags(active, { unrelated: true }, parse)).toBe(active)
})
test('226: active indicator follows effective effort and workflows, not raw flag', () => {
  for (const effort of [undefined, 'low', 'high', 'max'] as const) expect(ultracodeIsActive({ ultracode: true }, true, effort)).toBe(false)
  expect(ultracodeIsActive({ ultracode: true }, true, 'xhigh')).toBe(true)
  expect(ultracodeIsActive({ ultracode: true }, false, 'xhigh')).toBe(false)
  expect(ultracodeIsActive({}, true, 'xhigh')).toBe(false)
})
for (const subscription of ['pro', 'max', 'team', 'enterprise', null]) {
  test(`226: workflow defaults for ${subscription}`, () => {
    const availability = workflowAvailability({ envEnabled: false, envDisabled: false, gateEnabled: true, subscription })
    expect(availability).toEqual({ available: true, defaultOn: subscription !== 'pro' })
    expect(workflowsEnabled({ settings: { enableWorkflows: true }, disabledByEnv: false, policyAllowed: true, availability })).toBe(true)
    expect(workflowsEnabled({ settings: { enableWorkflows: true, disableWorkflows: true }, disabledByEnv: false, policyAllowed: true, availability })).toBe(false)
    expect(workflowsEnabled({ settings: { enableWorkflows: true }, disabledByEnv: false, policyAllowed: false, availability })).toBe(false)
    expect(workflowsEnabled({ settings: {}, disabledByEnv: true, policyAllowed: true, availability })).toBe(false)
  })
}
test('226: explicit env opt-in cannot override disabled feature gate', () => {
  expect(workflowAvailability({ envEnabled: true, envDisabled: false, gateEnabled: true, subscription: 'pro' })).toEqual({ available: true, defaultOn: true })
  expect(workflowAvailability({ envEnabled: true, envDisabled: false, gateEnabled: false, subscription: 'pro' })).toEqual({ available: false, defaultOn: false })
  expect(workflowAvailability({ envEnabled: false, envDisabled: true, gateEnabled: true, subscription: 'max' })).toEqual({ available: false, defaultOn: false })
})
test('226: keyword cannot accidentally trigger from quoted examples or file paths', () => {
  for (const text of ['/ultracode do this', '`ultracode`', '"ultracode"', "'ultracode'", '<ultracode>', '[ultracode]', '{ultracode}', '(ultracode)', 'src/ultracode.ts', 'ultracode/path', 'ultracode.md', '-ultracode', 'ultracode?', 'ultracode-mode']) expect(findUltracodeKeyword(text)).toEqual([])
  expect(findUltracodeKeyword('Please ULTRACODE this.')).toEqual([{ word: 'ULTRACODE', start: 7, end: 16 }])
  expect(findUltracodeKeyword('ultracode.')).toEqual([{ word: 'ultracode', start: 0, end: 9 }])
})
