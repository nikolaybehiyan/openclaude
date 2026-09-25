import React, { useEffect, useState } from 'react'
import { getTotalOutputTokens } from '../../bootstrap/state.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { getLastAchievedGoal } from '../../utils/goal.js'
import { call as runGoalCommand } from './goal-noninteractive.js'

export function GoalDialog({messages, onDone}: {messages: Message[]; onDone: () => void}) {
  const goal = useAppState((state: AppState) => state.activeGoal)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!goal) return
    const timer = setInterval(() => tick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [goal])
  if (goal) {
    const stats = [
      `running ${formatDuration(Date.now() - goal.setAt, {mostSignificantOnly: true})}`,
      goal.iterations > 0 && `${goal.iterations} ${goal.iterations === 1 ? 'turn' : 'turns'}`,
      `${formatTokens(getTotalOutputTokens() - goal.tokensAtStart)} tokens`,
    ].filter(Boolean).join(' · ')
    return <Dialog title="Goal active" subtitle={stats} onCancel={onDone}
      inputGuide={() => <Text>/goal clear to stop early · Esc to dismiss</Text>}>
      <Box flexDirection="column"><Text>Goal: {goal.condition}</Text>
        {goal.lastReason && <Text>Last check: {goal.lastReason.trim().split('\n', 1)[0]}</Text>}
      </Box>
    </Dialog>
  }
  const achieved = getLastAchievedGoal(messages)
  if (achieved) {
    const stats = [achieved.durationMs !== undefined && formatDuration(achieved.durationMs, {mostSignificantOnly: true}),
      achieved.iterations !== undefined && `${achieved.iterations} ${achieved.iterations === 1 ? 'turn' : 'turns'}`,
      achieved.tokens !== undefined && `${formatTokens(achieved.tokens)} tokens`].filter(value => value !== false).join(' · ')
    return <Dialog title="Goal achieved" color="success" subtitle={stats} onCancel={onDone}
      inputGuide={() => <Text>/goal &lt;condition&gt; to set another · Esc to dismiss</Text>}>
      <Text>Goal: {achieved.condition}</Text>
    </Dialog>
  }
  return <Dialog title="Goal" onCancel={onDone} inputGuide={() => <Text>Esc to dismiss</Text>}>
    <Text>No goal set · /goal &lt;condition&gt; to set one</Text>
  </Dialog>
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  if (!args.trim()) return <GoalDialog messages={context.messages} onDone={() => onDone(undefined, {display: 'skip'})} />
  const result = await runGoalCommand(args, context)
  if (result.type === 'query') onDone(result.value, {shouldQuery: true, metaMessages: [result.prompt]})
  else onDone(result.value, {display: 'system'})
  return null
}
