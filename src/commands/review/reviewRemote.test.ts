import { describe, expect, test } from 'bun:test'
import { SDKControlUltrareviewLaunchRequestSchema } from '../../entrypoints/sdk/controlSchemas.js'
import {
  buildUltrareviewOutcomeMessages,
  getBillingSettingsUrl,
} from './reviewRemote.js'
import {
  DEFAULT_ULTRAREVIEW_CONFIG,
  isUltrareviewConfigEnabled,
} from './ultrareviewEnabled.js'

describe('ultrareview SDK control parity', () => {
  test('defaults the missing GrowthBook entitlement to enabled', () => {
    expect(DEFAULT_ULTRAREVIEW_CONFIG).toEqual({ enabled: true })
    expect(isUltrareviewConfigEnabled(DEFAULT_ULTRAREVIEW_CONFIG)).toBe(true)
  })

  test('still honors an explicit GrowthBook disable', () => {
    expect(isUltrareviewConfigEnabled({ enabled: false })).toBe(false)
  })

  test('derives billing from the centralized Claude web origin', () => {
    const previous = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
    try {
      process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.claudia.ru'
      expect(getBillingSettingsUrl()).toBe(
        'https://ai.claudia.ru/settings/billing',
      )
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
      } else {
        process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = previous
      }
    }
  })

  test('accepts the native Electron request shape', () => {
    expect(
      SDKControlUltrareviewLaunchRequestSchema().parse({
        subtype: 'ultrareview_launch',
        args: '123',
        confirm: true,
      }),
    ).toEqual({ subtype: 'ultrareview_launch', args: '123', confirm: true })
  })

  test('does not mutate the transcript while confirmation is pending', () => {
    expect(
      buildUltrareviewOutcomeMessages('', {
        status: 'needs-confirm',
        body: 'Reviewing current branch',
        billingNote: '$10-$20',
      }),
    ).toEqual([])
  })

  test('records launched and blocked outcomes with XML escaping', () => {
    const launched = buildUltrareviewOutcomeMessages('12 < 13', {
      status: 'launched',
      sessionId: 'session-1',
      sessionUrl: 'https://example.test/session-1',
      message: 'Launched <success>',
      billingNote: '',
    })
    expect(launched.map(message => message.message.content)).toEqual([
      '<command-name>/ultrareview 12 &lt; 13</command-name>',
      '<local-command-stdout>Launched &lt;success&gt;</local-command-stdout>',
    ])

    const blocked = buildUltrareviewOutcomeMessages('', {
      status: 'blocked',
      message: 'Not allowed',
      actionUrl: 'https://example.test/billing?a=1&b=2',
    })
    expect(blocked.map(message => message.message.content)).toEqual([
      '<command-name>/ultrareview</command-name>',
      '<local-command-stderr>Ultrareview did not launch: Not allowed\nMore: https://example.test/billing?a=1&amp;b=2</local-command-stderr>',
    ])
  })
})
