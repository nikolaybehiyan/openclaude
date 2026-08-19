import { describe, expect, test } from 'bun:test'

import { buildMcpToolName } from './mcpStringUtils.js'

describe('Remote Code built-in MCP names', () => {
  test('projects Claude Code Remote tools with the 2.1.221 prefix', () => {
    expect(buildMcpToolName('Claude Code Remote', 'create_session')).toBe(
      'mcp__Claude_Code_Remote__create_session',
    )
    expect(buildMcpToolName('Claude Code Remote', 'subscribe_pr_activity')).toBe(
      'mcp__Claude_Code_Remote__subscribe_pr_activity',
    )
  })

  test('projects official GitHub tools with the built-in prefix', () => {
    expect(buildMcpToolName('github', 'get_pull_request')).toBe(
      'mcp__github__get_pull_request',
    )
  })
})
