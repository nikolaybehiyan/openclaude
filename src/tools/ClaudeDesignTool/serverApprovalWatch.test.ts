import { describe, expect, test } from 'bun:test'
import {
  createDesignProjectGrantObserver,
  parseDesignGrantSnapshot,
} from './serverApprovalWatch.js'

describe('Claude Design durable grant observer', () => {
  test('parses only the exact project grant and requires a valid created_at', () => {
    expect(
      parseDesignGrantSnapshot('project-a', {
        grants: [
          { project_id: 'project-b', created_at: '2026-08-19T00:00:00Z' },
          { project_id: 'project-a', created_at: '2026-08-19T00:00:01Z' },
        ],
      }),
    ).toEqual({
      present: true,
      createdAtMs: Date.parse('2026-08-19T00:00:01Z'),
    })
    expect(
      parseDesignGrantSnapshot('project-a', {
        grants: [{ project_id: 'project-a', created_at: 'not-a-date' }],
      }),
    ).toBeNull()
    expect(parseDesignGrantSnapshot('project-a', { grants: [] })).toEqual({
      present: false,
    })
    expect(parseDesignGrantSnapshot('project-a', {})).toBeNull()
  })

  test('seeds an absent baseline and observes a newly created grant', async () => {
    const snapshots = [
      { present: false } as const,
      { present: true, createdAtMs: 10 } as const,
    ]
    const observer = createDesignProjectGrantObserver(
      'project-a',
      async projectId => {
        expect(projectId).toBe('project-a')
        return snapshots.shift() ?? null
      },
    )
    expect(await observer.poll()).toBe(false)
    expect(await observer.poll()).toBe(true)
  })

  test('does not treat a grant present at baseline as a new approval', async () => {
    const snapshots = [
      { present: true, createdAtMs: 10 } as const,
      { present: true, createdAtMs: 10 } as const,
      { present: true, createdAtMs: 11 } as const,
    ]
    const observer = createDesignProjectGrantObserver(
      'project-a',
      async () => snapshots.shift() ?? null,
    )
    expect(await observer.poll()).toBe(false)
    expect(await observer.poll()).toBe(false)
    expect(await observer.poll()).toBe(true)
  })

  test('a failed poll cannot become the baseline', async () => {
    const snapshots = [
      null,
      { present: false } as const,
      { present: true, createdAtMs: 10 } as const,
    ]
    const observer = createDesignProjectGrantObserver(
      'project-a',
      async () => snapshots.shift() ?? null,
    )
    expect(await observer.poll()).toBe(false)
    expect(await observer.poll()).toBe(false)
    expect(await observer.poll()).toBe(true)
  })
})
