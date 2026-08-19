import type { Command } from '../../commands.js'
import { designGateFailure } from '../../services/design/gate.js'

const command = {
  type: 'local-jsx',
  name: 'design-login',
  description:
    'Authorize design-system access for /design-sync with your claude.ai account',
  isEnabled: () => designGateFailure() === null,
  load: () => import('./design-login.js'),
} satisfies Command

export default command
