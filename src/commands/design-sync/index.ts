import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Command } from '../../commands.js'
import { designGateFailure } from '../../services/design/gate.js'
import { DESIGN_SYNC_PROMPT } from '../../tools/DesignSyncTool/prompt.js'

const DESCRIPTION =
  'Push a React design system to claude.ai/design. This runs a converter that bundles the real component code (from Storybook or a bare package) and uploads it. Use when the user runs /design-sync or says "sync my design system to Claude Design".'

const command = {
  type: 'prompt',
  name: 'design-sync',
  description: 'Push your design system components to claude.ai/design',
  argumentHint: '[<project hint, e.g. "Acme DS">]',
  progressMessage: 'syncing the design system',
  contentLength: DESIGN_SYNC_PROMPT.length + DESCRIPTION.length,
  source: 'builtin',
  allowedTools: ['DesignSync'],
  disableModelInvocation: true,
  userInvocable: true,
  isEnabled: () => designGateFailure() === null,
  async getPromptForCommand(args: string): Promise<ContentBlockParam[]> {
    const hint = args.trim()
    return [
      {
        type: 'text',
        text: `${DESCRIPTION}\n\n${DESIGN_SYNC_PROMPT}${hint ? `\n\nProject hint from the user:\n${hint}` : ''}`,
      },
    ]
  },
} satisfies Command

export default command
