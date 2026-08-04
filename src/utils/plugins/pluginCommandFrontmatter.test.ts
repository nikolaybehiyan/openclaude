import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizePluginArgumentHint } from './pluginCommandFrontmatter.ts'

test('normalizes a YAML sequence argument hint to the SDK string contract', () => {
  assert.equal(
    normalizePluginArgumentHint(['business_description or seed_keywords']),
    'business_description or seed_keywords',
  )
})

test('preserves scalar plugin argument hints and omits missing values', () => {
  assert.equal(
    normalizePluginArgumentHint('[platform] [time_period]'),
    '[platform] [time_period]',
  )
  assert.equal(normalizePluginArgumentHint(undefined), undefined)
  assert.equal(normalizePluginArgumentHint(null), undefined)
})
