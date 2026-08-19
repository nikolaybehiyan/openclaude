import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  ClaudeDesignTool,
  setClaudeDesignToolDependenciesForTests,
} from './ClaudeDesignTool.js'
import {
  callClaudeDesignOperation,
  DesignProjectGrantRequiredError,
} from './client.js'

let needsConsent = false
let grantWrites = 0
let operationHandler: typeof callClaudeDesignOperation

let restoreDependencies: (() => void) | undefined

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
  operationHandler = async (operation) => {
    if (operation === 'get_project') {
      return { operation, content: [{ type: 'text', text: '{}' }] }
    }
    return { operation, content: [] }
  }
  restoreDependencies = setClaudeDesignToolDependenciesForTests({
    designGateFailure: () => null,
    resolveDesignAccessToken: async () => ({
      ok: true as const,
      accessToken: 'design-token',
    }),
    readDesignConsent: async () => !needsConsent,
    readDesignProjectGrants: async () => new Set<string>(),
    grantDesignConsent: async () => {},
    grantDesignProject: async () => {
      grantWrites++
    },
    callClaudeDesignOperation: (...args) => operationHandler(...args),
    verifyDesignProjectIdentity: () => ({
      name: 'Parity fixture',
      sharingLabel: 'private',
      url: 'https://ai.darbmind.ru/design/p/project-a',
    }),
  })
})

afterEach(() => {
  restoreDependencies?.()
  restoreDependencies = undefined
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
      throw new DesignProjectGrantRequiredError('project-a')
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
