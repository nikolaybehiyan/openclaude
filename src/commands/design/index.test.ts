import { expect, test } from 'bun:test'
import command from './index.js'

test('/design prompt teaches the exact ClaudeDesign operation envelope', async () => {
  const blocks = await command.getPromptForCommand('Create a private landing page')

  expect(blocks).toHaveLength(1)
  const block = blocks[0]
  expect(block?.type).toBe('text')
  if (!block || block.type !== 'text') {
    throw new Error('Expected a text prompt block')
  }
  const prompt = block.text
  expect(prompt).toContain('ClaudeDesign({operation: "list", arguments: {}})')
  expect(prompt).toContain(
    'ClaudeDesign({operation: "get_claude_design_prompt", arguments: {}})',
  )
  expect(prompt).toContain('Keep `operation` at the top level')
  expect(prompt).toContain('Never repeat or nest `operation` inside `arguments`')
})
