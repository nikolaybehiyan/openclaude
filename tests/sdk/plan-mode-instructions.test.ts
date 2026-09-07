import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { normalizeAttachmentForAPI } from '../../src/utils/messages.js'
import { SDKControlInitializeRequestSchema } from '../../src/entrypoints/sdk/controlSchemas.js'

const base = { type: 'plan_mode' as const, reminderType: 'full' as const,
  planFilePath: '/workspace/plans/cowork.md', planExists: false }

function render(overrides: Record<string, unknown> = {}) {
  return normalizeAttachmentForAPI({ ...base, ...overrides }).map(message => message.message.content).join('\n')
}

test('initialize accepts only a string workflow', () => {
  expect(SDKControlInitializeRequestSchema().parse({ subtype: 'initialize', planModeInstructions: 'COWORK' }).planModeInstructions).toBe('COWORK')
  expect(SDKControlInitializeRequestSchema().safeParse({ subtype: 'initialize', planModeInstructions: ['COWORK'] }).success).toBe(false)
})

test('custom workflow replaces Code phases, preserves readonly preamble and approval footer', () => {
  const body = 'COWORK: inspect the attached spreadsheet and plan the deliverables.'
  const actual = render({ customInstructions: body })
  expect(actual).toContain(body)
  expect(actual).toContain('MUST NOT make any edits')
  expect(actual).toContain('only file you are allowed to edit')
  expect(actual).toContain(base.planFilePath)
  expect(actual).toContain('### Call ExitPlanMode')
  expect(actual).toContain('Use ExitPlanMode to request plan approval')
  expect(actual.indexOf('MUST NOT')).toBeLessThan(actual.indexOf(body))
  expect(actual.indexOf(body)).toBeLessThan(actual.indexOf('### Call ExitPlanMode'))
  expect(actual).not.toContain('### Phase 1:')
  expect(actual).toStartWith('<system-reminder>')
})

test('existing plan and sparse reminder retain the custom workflow, not Code phases', () => {
  expect(render({ planExists: true, customInstructions: 'COWORK' })).toContain('A plan file already exists')
  const sparse = render({ reminderType: 'sparse', customInstructions: 'COWORK' })
  expect(sparse).toContain('Follow the plan workflow described earlier.')
  expect(sparse).toContain('Read-only except plan file')
  expect(sparse).toContain('ExitPlanMode')
  expect(sparse).not.toContain('5-phase')
})

test('empty custom body retains default Code behavior and subagent reminder stays read-only', () => {
  expect(render({ customInstructions: '' })).toBe(render())
  const subagent = render({ isSubAgent: true, customInstructions: 'PARENT_CUSTOM_BODY' })
  expect(subagent).toContain('MUST NOT make any edits')
  expect(subagent).not.toContain('PARENT_CUSTOM_BODY')
})

test('post-compaction attachment preserves the host workflow', () => {
  // Isolate plan path mocks; this check does not read/write the real plans dir.
  const result = spawnSync(process.execPath, ['-e', `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    const plans = { ...await import('./src/utils/plans.js') };
    mock.module('./src/utils/plans.js', () => ({ ...plans, getPlanFilePath: () => '/workspace/plan.md', getPlan: () => null }));
    const { createPlanModeAttachmentIfNeeded } = await import('./src/services/compact/compact.ts');
    const context = { options: { planModeInstructions: 'COWORK_AFTER_COMPACT' }, getAppState: () => ({ toolPermissionContext: { mode: 'plan' } }) };
    const result = await createPlanModeAttachmentIfNeeded(context);
    assert.equal(result.attachment.customInstructions, 'COWORK_AFTER_COMPACT');
    assert.equal(result.attachment.reminderType, 'full');
    context.getAppState = () => ({ toolPermissionContext: { mode: 'default' } });
    assert.equal(await createPlanModeAttachmentIfNeeded(context), null);
    console.log('plan-compact-pass');
  `], { cwd: new URL('../..', import.meta.url), encoding: 'utf8', timeout: 20_000 })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe('plan-compact-pass')
})
