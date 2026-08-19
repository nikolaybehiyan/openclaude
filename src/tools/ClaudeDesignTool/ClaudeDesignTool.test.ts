import { beforeEach, describe, expect, mock, test } from 'bun:test'

let needsConsent = false
let grantWrites = 0
let operationHandler: (
  operation: string,
) => Promise<Record<string, unknown>>

class TestDesignProjectGrantRequiredError extends Error {
  constructor(readonly projectId: string) {
    super('project grant required')
  }
}

class TestDesignConsentRequiredError extends Error {
  constructor(readonly consent: string) {
    super('consent required')
  }
}

mock.module('../../services/design/auth.js', () => ({
  resolveDesignAccessToken: async () => ({
    ok: true as const,
    accessToken: 'design-token',
  }),
}))

mock.module('../../services/design/control.js', () => ({
  readDesignConsent: async () => !needsConsent,
  readDesignProjectGrants: async () => new Set<string>(),
  grantDesignConsent: async () => {},
  grantDesignProject: async () => {
    grantWrites++
  },
}))

mock.module('../../services/design/gate.js', () => ({
  designGateFailure: () => null,
}))

mock.module('../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => true,
}))

mock.module('./client.js', () => ({
  callClaudeDesignOperation: async (operation: string) =>
    operationHandler(operation),
  DesignConsentRequiredError: TestDesignConsentRequiredError,
  DesignProjectGrantRequiredError: TestDesignProjectGrantRequiredError,
}))

mock.module('./projectIdentity.js', () => ({
  verifyDesignProjectIdentity: () => ({
    name: 'Parity fixture',
    sharingLabel: 'private',
    url: 'https://ai.darbmind.ru/design/p/project-a',
  }),
}))

const { ClaudeDesignTool } = await import('./ClaudeDesignTool.js')

function context() {
  const abortController = new AbortController()
  return {
    abortController,
    agentId: undefined,
    options: { isNonInteractiveSession: false },
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        shouldAvoidPermissionPrompts: false,
        isBypassPermissionsModeAvailable: false,
      },
    }),
  } as any
}

const writeInput = {
  operation: 'write_files' as const,
  arguments: {
    project_id: 'project-a',
    files: [{ path: 'index.html', data: '<main>safe</main>' }],
  },
}

beforeEach(() => {
  needsConsent = false
  grantWrites = 0
  operationHandler = async operation => {
    if (operation === 'get_project') {
      return { operation, content: [{ type: 'text', text: '{}' }] }
    }
    return { operation, content: [] }
  }
})

describe('ClaudeDesign 2.1.221 permission metadata', () => {
  test('keeps the consent prompt local-only', async () => {
    needsConsent = true
    const result = await ClaudeDesignTool.checkPermissions(
      writeInput,
      context(),
    )
    expect(result.behavior).toBe('ask')
    if (result.behavior !== 'ask') throw new Error('expected ask')
    expect(result.localDisplayOnly).toBe(true)
    expect(result.serverApprovalWatch).toBeUndefined()
  })

  test('attaches the exact project grant watcher to the durable ask', async () => {
    const result = await ClaudeDesignTool.checkPermissions(
      writeInput,
      context(),
    )
    expect(result.behavior).toBe('ask')
    if (result.behavior !== 'ask') throw new Error('expected ask')
    expect(result.localDisplayOnly).toBe(true)
    expect(result.serverApprovalWatch).toEqual({
      kind: 'design_project_grant',
      projectId: 'project-a',
    })
  })

  test('never POSTs a grant after the server watcher supplied approval', async () => {
    operationHandler = async () => {
      throw new TestDesignProjectGrantRequiredError('project-a')
    }
    await expect(
      ClaudeDesignTool.call(
        {
          ...writeInput,
          __projectGrantAskShown: 'project-a',
          __projectGrantServerObserved: true,
          __approvalCanReachUser: true,
        } as any,
        context(),
      ),
    ).rejects.toThrow('requires a durable write grant')
    expect(grantWrites).toBe(0)
  })
})
