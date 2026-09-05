import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createBundledSkillCommand } from './bundledSkills.js'

const originalMacro = (globalThis as Record<string, unknown>).MACRO
beforeEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'design-sync-test' }
})
afterEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
})

test('lazy resources are not loaded before invocation and concurrent calls load only once', async () => {
  let calls = 0
  const skill = createBundledSkillCommand({
    name: `lazy-fixture-${randomUUID()}`,
    description: 'Test fixture',
    files: async () => { calls++; return { 'lib/example.mjs': 'export const value = 1\n' } },
    getPromptForCommand: async args => [{ type: 'text', text: args }],
  })
  expect(calls).toBe(0)
  await Promise.all([
    skill.getPromptForCommand('one', {} as never),
    skill.getPromptForCommand('two', {} as never),
  ])
  expect(calls).toBe(1)
  expect(await readFile(join(skill.skillRoot!, 'lib/example.mjs'), 'utf8')).toBe('export const value = 1\n')
})

test('eager bundled files retain their extraction contract', async () => {
  const skill = createBundledSkillCommand({
    name: `eager-fixture-${randomUUID()}`,
    description: 'Test fixture',
    files: { 'reference.md': 'Reference content' },
    getPromptForCommand: async () => [{ type: 'text', text: 'Prompt' }],
  })
  const blocks = await skill.getPromptForCommand('', {} as never)
  expect(blocks[0]).toEqual({ type: 'text', text: `Base directory for this skill: ${skill.skillRoot}\n\nPrompt` })
  expect(await readFile(join(skill.skillRoot!, 'reference.md'), 'utf8')).toBe('Reference content')
})
