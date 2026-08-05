import { describe, expect, test } from 'bun:test'
import { SDKControlUltrareviewLaunchRequestSchema } from '../../entrypoints/sdk/controlSchemas.js'
import { buildUltrareviewOutcomeMessages } from './reviewRemote.js'

describe('ultrareview SDK control parity', () => {
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
