import type { Command } from '../../commands.js'
import { designGateFailure } from '../../services/design/gate.js'

const command = {
  type: 'local',
  name: 'design-revoke',
  description: 'Revoke Claude agent access to your Design projects',
  supportsNonInteractive: false,
  isEnabled: () => designGateFailure() === null,
  load: () => import('./design-revoke.js'),
} satisfies Command

export default command
