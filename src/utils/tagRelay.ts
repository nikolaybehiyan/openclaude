import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type {
  QueuedCommand,
  QueuePriority,
} from '../types/textInputTypes.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { CCR_TURN_ID_MAX_LENGTH } from './ccrTurnContext.js'

type RelayMetadata = {
  client_platform?: unknown
  inbound_origin?: unknown
  turn_id?: unknown
}

const SLACK_CLIENT_PLATFORMS = new Set([
  'claude-in-slack',
  'claude_in_slack',
])

export const TAG_RELAY_MESSAGE_PREFIX =
  'A message arrived in the bound thread while you were working:\n'

export function wrapTagRelayText(text: string): string {
  return `${TAG_RELAY_MESSAGE_PREFIX}${text}`
}

export function isVerifiedTagRelayHuman(
  message: RelayMetadata,
): boolean {
  return (
    (typeof message.client_platform === 'string' &&
      SLACK_CLIENT_PLATFORMS.has(message.client_platform) &&
      message.inbound_origin === 'slack_human') ||
    (message.client_platform === 'claude-in-teams' &&
      message.inbound_origin === 'teams_human')
  )
}

export function extractCcrTurnId(
  message: RelayMetadata,
  isRelayHuman: boolean,
): string | undefined {
  if (!isRelayHuman) return undefined
  const id = message.turn_id
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > CCR_TURN_ID_MAX_LENGTH ||
    !/^[\x21-\x7e]+$/.test(id)
  ) {
    return undefined
  }
  return id
}

export function isSlashPrompt(
  value: string | ReadonlyArray<ContentBlockParam>,
): boolean {
  if (typeof value === 'string') return value.trim().startsWith('/')
  for (const block of value) {
    if (block.type === 'text') return block.text.trim().startsWith('/')
  }
  return false
}

export function hasPendingLaterRelay(
  queue: ReadonlyArray<QueuedCommand>,
): boolean {
  return queue.some(
    command =>
      command.verifiedSlackHumanTurn === true && command.priority === 'later',
  )
}

export function resolveTagRelayPriority({
  explicitPriority,
  value,
  queue,
}: {
  explicitPriority: QueuePriority | undefined
  value: string | ReadonlyArray<ContentBlockParam>
  queue: ReadonlyArray<QueuedCommand>
}): QueuePriority {
  if (isSlashPrompt(value)) return 'later'
  if (explicitPriority === 'now') return 'now'
  if (hasPendingLaterRelay(queue)) return 'later'
  if (explicitPriority !== undefined) return explicitPriority
  return getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_pencil_farmer',
    false,
  )
    ? 'next'
    : 'later'
}
