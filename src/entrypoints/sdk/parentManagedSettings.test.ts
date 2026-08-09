import { afterEach, describe, expect, test } from 'bun:test'
import {
  getParentManagedSettings,
  resetStateForTests,
} from '../../bootstrap/state.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import {
  buildParentManagedSettingsGuard,
  loadParentManagedSettingsFromFlag,
  restrictParentManagedSettings,
  shouldMergeParentManagedSettings,
  validateParentManagedSettings,
} from './parentManagedSettings.js'

afterEach(() => {
  resetStateForTests()
})

describe('--managed-settings compatibility with Claude Code 2.1.221', () => {
  test('accepts an object and ignores malformed or non-object JSON', () => {
    loadParentManagedSettingsFromFlag('{"allowManagedMcpServersOnly":true}')
    expect(getParentManagedSettings()).toEqual({
      allowManagedMcpServersOnly: true,
    })

    for (const invalid of ['{', 'null', '[]', '"settings"']) {
      loadParentManagedSettingsFromFlag(invalid)
      expect(getParentManagedSettings()).toEqual({
        allowManagedMcpServersOnly: true,
      })
    }
  })

  test('keeps the parent tier separate and validates its schema', () => {
    loadParentManagedSettingsFromFlag(
      JSON.stringify({
        forceLoginOrgUUID: ['org-a', 'org-b'],
        parentSettingsBehavior: 'merge',
      }),
    )
    const result = validateParentManagedSettings()
    expect(result.present).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.settings).toMatchObject({
      forceLoginOrgUUID: ['org-a', 'org-b'],
      parentSettingsBehavior: 'merge',
    })
  })

  test('invalid model and organization allowlists fail closed', () => {
    loadParentManagedSettingsFromFlag(
      JSON.stringify({
        availableModels: 'all',
        enforceAvailableModels: true,
        forceLoginOrgUUID: 42,
      }),
    )
    const result = validateParentManagedSettings()
    expect(result.settings).toMatchObject({
      availableModels: [],
      enforceAvailableModels: true,
      forceLoginOrgUUID: [],
    })
    expect(result.errors.map(error => error.path)).toEqual([
      'availableModels',
      'forceLoginOrgUUID',
    ])
  })

  test('admin policy is first-wins by default and merge is explicit', () => {
    expect(shouldMergeParentManagedSettings(null)).toBe(true)
    expect(shouldMergeParentManagedSettings({})).toBe(false)
    expect(
      shouldMergeParentManagedSettings({ parentSettingsBehavior: 'firstWins' }),
    ).toBe(false)
    expect(
      shouldMergeParentManagedSettings({ parentSettingsBehavior: 'merge' }),
    ).toBe(true)
  })

  test('drops permissive parent settings while retaining restrictions', () => {
    const restricted = restrictParentManagedSettings(
      {
        apiKeyHelper: '/tmp/not-admitted',
        env: { SECRET: 'not-admitted' },
        model: 'not-admitted',
        allowManagedHooksOnly: true,
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [],
        deniedMcpServers: [{ serverName: 'blocked' }],
        availableModels: ['sonnet'],
        enforceAvailableModels: true,
        forceLoginOrgUUID: 'org-parent',
        permissions: {
          allow: ['Read(/safe/**)'],
          ask: ['Bash(git push:*)'],
          deny: ['Bash(rm:*)'],
          additionalDirectories: ['/safe'],
          disableBypassPermissionsMode: 'disable',
        },
      } as SettingsJson,
      null,
    )

    expect(restricted).toEqual({
      allowManagedHooksOnly: true,
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [],
      deniedMcpServers: [{ serverName: 'blocked' }],
      availableModels: ['sonnet'],
      enforceAvailableModels: true,
      forceLoginOrgUUID: 'org-parent',
      permissions: {
        allow: ['Read(/safe/**)'],
        ask: ['Bash(git push:*)'],
        deny: ['Bash(rm:*)'],
        additionalDirectories: ['/safe'],
        disableBypassPermissionsMode: 'disable',
      },
    })
  })

  test('admin-owned dimensions suppress parent grants but not parent denies', () => {
    const restricted = restrictParentManagedSettings(
      {
        forceLoginOrgUUID: 'org-parent',
        allowedMcpServers: [{ serverName: 'parent-server' }],
        availableModels: ['parent-model'],
        permissions: {
          allow: ['Read(/parent/**)'],
          deny: ['Bash(rm:*)'],
        },
        sandbox: {
          network: { allowedDomains: ['parent.example'] },
          filesystem: { allowRead: ['/parent'] },
        },
      } as SettingsJson,
      {
        parentSettingsBehavior: 'merge',
        forceLoginOrgUUID: 'org-admin',
        allowedMcpServers: [{ serverName: 'admin-server' }],
        availableModels: ['admin-model'],
        allowManagedPermissionRulesOnly: true,
        sandbox: {
          network: { allowManagedDomainsOnly: true },
          filesystem: { allowManagedReadPathsOnly: true },
        },
      } as SettingsJson,
    )

    expect(restricted).toEqual({
      permissions: { deny: ['Bash(rm:*)'] },
    })
  })

  test('lower-priority admin tiers still lock parent-managed dimensions', () => {
    const guard = buildParentManagedSettingsGuard([
      {
        parentSettingsBehavior: 'merge',
        availableModels: ['primary-model'],
      },
      {
        forceLoginOrgUUID: 'org-lower-tier',
        allowedMcpServers: [],
        allowManagedPermissionRulesOnly: true,
        sandbox: {
          network: { allowManagedDomainsOnly: true },
          filesystem: { allowManagedReadPathsOnly: true },
        },
      },
    ])

    expect(guard).toEqual({
      allowManagedPermissionRulesOnly: true,
      forceLoginOrgUUID: 'org-lower-tier',
      allowedMcpServers: [],
      availableModels: ['primary-model'],
      sandbox: {
        network: { allowManagedDomainsOnly: true },
        filesystem: { allowManagedReadPathsOnly: true },
      },
    })
  })

  test('normalizes parent sandbox credentials to deny or masked empty-host injection', () => {
    const restricted = restrictParentManagedSettings(
      {
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          autoAllowBashIfSandboxed: false,
          network: {
            deniedDomains: ['blocked.example'],
            strictAllowlist: true,
          },
          filesystem: {
            denyRead: ['/secret'],
            denyWrite: ['/protected'],
            disabled: false,
          },
          credentials: {
            files: [
              { path: '/deny', mode: 'deny' },
              { path: '/mask', mode: 'allow', injectHosts: ['host'] },
            ],
            envVars: [
              { name: 'DENY_ME', mode: 'deny' },
              { name: 'DROP_ME', mode: 'allow' },
            ],
            allowPlaintextInject: false,
          },
        },
      } as SettingsJson,
      null,
    )

    expect(restricted?.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: {
        deniedDomains: ['blocked.example'],
        strictAllowlist: true,
      },
      filesystem: {
        denyRead: ['/secret'],
        denyWrite: ['/protected'],
        disabled: false,
      },
      credentials: {
        files: [
          { path: '/deny', mode: 'deny' },
          { path: '/mask', mode: 'mask', injectHosts: [] },
        ],
        envVars: [{ name: 'DENY_ME', mode: 'deny' }],
        allowPlaintextInject: false,
      },
    })
  })
})
