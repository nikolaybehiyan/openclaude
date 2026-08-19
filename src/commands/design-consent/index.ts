import type { Command } from '../../commands.js'
import { designGateFailure } from '../../services/design/gate.js'

const command = {
  type: 'local',
  name: 'design-consent',
  description: 'Grant Claude agent access to your Design projects',
  supportsNonInteractive: false,
  isEnabled: () => designGateFailure() === null,
  load: () => import('./design-consent.js'),
} satisfies Command

export default command
