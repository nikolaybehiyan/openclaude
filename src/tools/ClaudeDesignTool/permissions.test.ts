import { beforeEach, describe, expect, test } from 'bun:test'
import {
  approvedMcpPlanAllows,
  recordApprovedMcpPlan,
  resetApprovedMcpPlansForTests,
  tokenlessWriteTargets,
} from './permissions.js'

beforeEach(() => resetApprovedMcpPlansForTests())

describe('ClaudeDesign write permission boundary', () => {
  test('keeps instruction-bearing and unenumerable tokenless writes on per-batch plans', () => {
    expect(
      tokenlessWriteTargets('write_files', {
        files: [{ path: 'CLAUDE.md', data: 'instructions' }],
      }),
    ).toEqual({ outcome: 'reserved_or_unrenderable' })
    expect(
      tokenlessWriteTargets('write_files', { files: [] }),
    ).toEqual({ outcome: 'empty' })
    expect(
      tokenlessWriteTargets('write_files', {
        files: [{ path: 'slides/intro.html', data: '<h1>Hello</h1>' }],
      }),
    ).toEqual({ outcome: 'pass', targets: ['slides/intro.html'] })
  })

  test('allows a plan token only for the approved project, operation, and path', () => {
    recordApprovedMcpPlan(
      {
        project_id: 'project-1',
        writes: ['slides/intro.html'],
        deletes: ['slides/old.html'],
      },
      [
        {
          type: 'text',
          text: JSON.stringify({
            plan_token: 'plan-token',
            expires_at: Math.floor(Date.now() / 1000) + 600,
          }),
        },
      ],
    )

    expect(
      approvedMcpPlanAllows('write_files', {
        project_id: 'project-1',
        plan_token: 'plan-token',
        files: [{ path: 'slides/intro.html', data: '<h1>Hello</h1>' }],
      }),
    ).toBe(true)
    expect(
      approvedMcpPlanAllows('write_files', {
        project_id: 'project-1',
        plan_token: 'plan-token',
        files: [{ path: 'slides/other.html', data: 'no' }],
      }),
    ).toBe(false)
    expect(
      approvedMcpPlanAllows('delete_files', {
        project_id: 'project-2',
        plan_token: 'plan-token',
        paths: ['slides/old.html'],
      }),
    ).toBe(false)
  })
})
