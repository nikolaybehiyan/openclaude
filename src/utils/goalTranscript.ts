type TranscriptEntry = {
  uuid?: string
  parentUuid?: string | null
  type: string
  attachment?: {type?: string}
  timestamp?: string
}

/** Conversation leaves are user/assistant messages. Goal completion/clear can
 * follow that leaf without another model turn. Retain only those trailing goal
 * markers, stopping at the next conversational branch and guarding cycles. */
export function withTrailingGoalStatuses<T extends TranscriptEntry>(
  messages: ReadonlyMap<string, T>, chain: T[],
): T[] {
  const leaf = chain.at(-1)
  if (!leaf?.uuid) return chain
  const children = new Map<string, T[]>()
  for (const entry of messages.values()) {
    if (!entry.parentUuid) continue
    const siblings = children.get(entry.parentUuid) ?? []
    siblings.push(entry); children.set(entry.parentUuid, siblings)
  }
  const seen = new Set(chain.map(entry => entry.uuid))
  const pending = [...(children.get(leaf.uuid) ?? [])]
  const trailing: T[] = []
  for (let index = 0; index < pending.length; index++) {
    const entry = pending[index]!
    if (!entry.uuid || seen.has(entry.uuid)) continue
    seen.add(entry.uuid)
    if (entry.type === 'user' || entry.type === 'assistant') continue
    if (entry.type === 'attachment' && entry.attachment?.type === 'goal_status') trailing.push(entry)
    pending.push(...(children.get(entry.uuid) ?? []))
  }
  if (!trailing.length) return chain
  trailing.sort((a,b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
  return [...chain, ...trailing]
}
