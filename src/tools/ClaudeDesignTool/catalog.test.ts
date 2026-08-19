import { beforeEach, describe, expect, test } from 'bun:test'
import {
  installDesignCatalog,
  operationMetadata,
  resetDesignCatalogForTests,
  validateDesignOperation,
} from './catalog.js'

beforeEach(() => resetDesignCatalogForTests())

describe('ClaudeDesign operation catalog', () => {
  test('permits a newly discovered operation only when it is read-only', () => {
    installDesignCatalog([
      {
        name: 'new_read',
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'new_write',
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
    ])
    expect(validateDesignOperation('new_read', { any: 'server validated' })).toBe(
      null,
    )
    expect(validateDesignOperation('new_write', {})).toContain(
      "can't validate its arguments",
    )
  })

  test('never lets server annotations weaken a known destructive operation', () => {
    installDesignCatalog([
      {
        name: 'delete_files',
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    ])
    expect(operationMetadata('delete_files')).toEqual({
      readOnly: false,
      destructive: true,
    })
  })

  test('validates exact write schemas and rejects lookalikes', () => {
    expect(
      validateDesignOperation('write_files', {
        project_id: 'p',
        files: [{ path: 'card.html', data: '<main />' }],
      }),
    ).toBe(null)
    expect(
      validateDesignOperation('write_files', {
        project_id: 'p',
        files: [{ path: 'card.html', content: '<main />' }],
      }),
    ).toContain("did you mean 'data'")
    expect(
      validateDesignOperation('update_sharing', {
        project_id: 'p',
        scope: 'public',
      }),
    ).toContain('must be one of')
  })

  test('rejects project-scoped plans that also enumerate paths', () => {
    expect(
      validateDesignOperation('finalize_plan', {
        project_id: 'p',
        scope: 'project',
        writes: ['a'],
      }),
    ).toContain('takes no writes/deletes')
  })
})
