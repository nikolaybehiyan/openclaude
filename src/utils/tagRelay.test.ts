import { describe, expect, test } from 'bun:test'
import {
  extractCcrTurnId,
  isVerifiedTagRelayHuman,
  resolveTagRelayPriority,
  wrapTagRelayText,
} from './tagRelay.js'
import {
  CCR_TURN_ID_HEADER,
  getCcrTurnId,
  iterateWithCcrTurnId,
  runWithCcrTurnId,
  selectCcrTurnId,
  withCurrentCcrTurnHeader,
} from './ccrTurnContext.js'

describe('Claude Tag relay metadata from 2.1.221', () => {
  test('requires an exact platform and inbound-origin pair', () => {
    expect(
      isVerifiedTagRelayHuman({
        client_platform: 'claude_in_slack',
        inbound_origin: 'slack_human',
      }),
    ).toBe(true)
    expect(
      isVerifiedTagRelayHuman({
        client_platform: 'claude-in-teams',
        inbound_origin: 'teams_human',
      }),
    ).toBe(true)
    expect(
      isVerifiedTagRelayHuman({
        client_platform: 'web_claude_ai',
        inbound_origin: 'slack_human',
      }),
    ).toBe(false)
    expect(
      isVerifiedTagRelayHuman({
        client_platform: 'claude_in_slack',
        inbound_origin: 'teams_human',
      }),
    ).toBe(false)
  })

  test('uses the exact relay envelope recovered from 2.1.221', () => {
    expect(wrapTagRelayText('please inspect the failure')).toBe(
      'A message arrived in the bound thread while you were working:\nplease inspect the failure',
    )
  })

  test('accepts only printable non-space ASCII turn ids up to 128 bytes', () => {
    const relay = true
    expect(extractCcrTurnId({ turn_id: 'turn-123_ABC' }, relay)).toBe(
      'turn-123_ABC',
    )
    expect(extractCcrTurnId({ turn_id: 'contains space' }, relay)).toBeUndefined()
    expect(extractCcrTurnId({ turn_id: 'é' }, relay)).toBeUndefined()
    expect(extractCcrTurnId({ turn_id: 'x'.repeat(129) }, relay)).toBeUndefined()
    expect(
      extractCcrTurnId({ turn_id: 'turn-123' }, false),
    ).toBeUndefined()
  })

  test('uses the official relay priority state machine', () => {
    expect(
      resolveTagRelayPriority({
        explicitPriority: 'now',
        value: '/status',
        queue: [],
      }),
    ).toBe('later')
    expect(
      resolveTagRelayPriority({
        explicitPriority: 'now',
        value: 'interrupt now',
        queue: [],
      }),
    ).toBe('now')
    expect(
      resolveTagRelayPriority({
        explicitPriority: 'next',
        value: 'second relay turn',
        queue: [
          {
            mode: 'prompt',
            value: 'first relay turn',
            priority: 'later',
            verifiedSlackHumanTurn: true,
          },
        ],
      }),
    ).toBe('later')
    expect(
      resolveTagRelayPriority({
        explicitPriority: 'next',
        value: 'explicit next',
        queue: [],
      }),
    ).toBe('next')
    expect(
      resolveTagRelayPriority({
        explicitPriority: undefined,
        value: 'default relay turn',
        queue: [],
      }),
    ).toBe('later')
  })

  test('keeps one turn id for a homogeneous batch and refreshes its header', async () => {
    expect(
      selectCcrTurnId([{ ccrTurnId: 'a' }, { ccrTurnId: 'a' }]),
    ).toBe('a')
    expect(
      selectCcrTurnId([{ ccrTurnId: 'a' }, { ccrTurnId: 'b' }]),
    ).toBeUndefined()

    const headers = runWithCcrTurnId('turn-9', () =>
      new Headers(
        withCurrentCcrTurnHeader({
          headers: { [CCR_TURN_ID_HEADER]: 'stale' },
        }).headers,
      ),
    )
    expect(headers.get(CCR_TURN_ID_HEADER)).toBe('turn-9')

    const cleared = new Headers(
      withCurrentCcrTurnHeader({
        headers: { [CCR_TURN_ID_HEADER]: 'stale' },
      }).headers,
    )
    expect(cleared.get(CCR_TURN_ID_HEADER)).toBeNull()

    async function* observeContext() {
      yield getCcrTurnId()
      await Promise.resolve()
      yield getCcrTurnId()
    }
    const observed: Array<string | undefined> = []
    for await (const id of iterateWithCcrTurnId('turn-10', observeContext())) {
      observed.push(id)
    }
    expect(observed).toEqual(['turn-10', 'turn-10'])
  })
})
