import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../types/command.js'

export const goal: Command = {
  type: 'local-jsx', name: 'goal', description: 'Set a goal Darb checks before stopping',
  argumentHint: '[<condition> | clear]', immediate: true,
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./goal.js'),
}
export const goalNonInteractive: Command = {
  type: 'local', name: 'goal', description: 'Set a goal — keep working until the condition is met',
  supportsNonInteractive: true,
  get isHidden() { return !getIsNonInteractiveSession() },
  isEnabled: () => getIsNonInteractiveSession(),
  load: () => import('./goal-noninteractive.js'),
}
export default goal
