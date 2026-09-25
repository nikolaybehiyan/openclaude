import { SDKActiveGoalMessageSchema } from '../../entrypoints/sdk/coreSchemas.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { ActiveGoal } from '../../utils/goal.js'
import { decodeActiveGoal } from './wire.js'

type GoalSetter = (update: (state: AppState) => AppState) => void
export type GoalHistoryPage = {events: readonly unknown[]; firstId: string | null; hasMore: boolean}
type HistoryLoader = {latest(): Promise<GoalHistoryPage | null>; older(cursor: string): Promise<GoalHistoryPage | null>}
// All connection hooks use the stable AppStore.setState reference. A new
// controller takes ownership immediately; cleanup from the old transport must
// never clear or overwrite the new session, even when both goals are absent.
const owners = new WeakMap<GoalSetter, object>()

/** Goal state is separate from chat history. Revision/request guards stop a
 * slow history fetch, old connection or earlier page overwriting live state. */
export function createRemoteGoalController(setState: GoalSetter, sessionId?: string) {
  let revision = 0, request = 0, disposed = false
  const owner = {}
  owners.set(setState, owner)
  const isCurrent = () => !disposed && owners.get(setState) === owner
  const update = (goal: ActiveGoal | undefined) => {
    if (isCurrent()) setState(state => state.activeGoal === goal ? state : {...state, activeGoal: goal})
  }
  function decode(message: unknown): {value: ActiveGoal | undefined} | null {
    const parsed = SDKActiveGoalMessageSchema().safeParse(message)
    return parsed.success && (!sessionId || parsed.data.session_id === sessionId)
      ? {value: decodeActiveGoal(parsed.data.value)} : null
  }
  return {
    receive(message: unknown): boolean {
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'active_goal') return false
      if (!isCurrent()) return true
      const parsed = decode(message)
      if (parsed) { revision++; update(parsed.value) }
      return true
    },
    seed(goal: ActiveGoal | null): void {
      if (isCurrent()) { revision++; update(goal ?? undefined) }
    },
    clear(): void { if (isCurrent()) { revision++; request++; update(undefined) } },
    dispose(): void {
      if (disposed) return
      if (isCurrent()) { update(undefined); owners.delete(setState) }
      disposed = true; revision++; request++
    },
    async refresh(loader: HistoryLoader): Promise<void> {
      if (!isCurrent()) return
      const expectedRevision = revision, ownRequest = ++request
      const current = () => isCurrent() && revision === expectedRevision && request === ownRequest
      try {
        let page = await loader.latest()
        const cursors = new Set<string>()
        // Bound pathological histories. Partial/failed history is unknown,
        // never evidence that a goal completed or was cleared.
        for (let count = 0; page && current() && count < 25; count++) {
          for (let index = page.events.length - 1; index >= 0; index--) {
            const event = page.events[index]
            const parsed = decode(event)
            if (parsed) { revision++; update(parsed.value); return }
            if (event && typeof event === 'object' && 'type' in event && event.type === 'conversation_reset') {
              revision++; update(undefined); return
            }
          }
          if (!page.hasMore) { revision++; update(undefined); return }
          if (!page.firstId || cursors.has(page.firstId)) return
          cursors.add(page.firstId)
          if (count < 24) page = await loader.older(page.firstId)
        }
      } catch { /* History is best effort; the live stream remains authoritative. */ }
    },
  }
}
