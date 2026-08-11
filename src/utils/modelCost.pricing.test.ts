import { describe, expect, test } from 'bun:test'

import {
  COST_TIER_10_50,
  COST_TIER_2_10,
  COST_TIER_5_25,
  calculateUSDCost,
  getModelCosts,
  getOpus46CostTier,
} from './modelCost.js'
import { firstPartyNameToCanonical } from './model/model.js'

const oneMillionInput = {
  input_tokens: 1_000_000,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
} as const

describe('current first-party model pricing', () => {
  test.each([
    ['claude-fable-5', 'claude-fable-5', COST_TIER_10_50, 10],
    ['claude-opus-5', 'claude-opus-5', COST_TIER_5_25, 5],
    ['claude-opus-4-8[1m]', 'claude-opus-4-8', COST_TIER_5_25, 5],
    ['claude-sonnet-5', 'claude-sonnet-5', COST_TIER_2_10, 2],
  ])('%s uses its official price tier', (model, canonical, tier, expected) => {
    expect(firstPartyNameToCanonical(model)).toBe(canonical)
    expect(getModelCosts(model, oneMillionInput as never)).toBe(tier)
    expect(calculateUSDCost(model, oneMillionInput as never)).toBe(expected)
  })

  test('Opus 4.6 fast-shaped usage stays on standard pricing', () => {
    expect(getOpus46CostTier(true)).toBe(COST_TIER_5_25)
  })
})
