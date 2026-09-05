import { getOauthConfig } from '../../constants/oauth.js'
import { designGateFailure } from '../../services/design/gate.js'
import { createBundledSkillCommand } from '../../skills/bundledSkills.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'

const DESCRIPTION =
  'Push a React design system to claude.ai/design. This runs a converter that bundles the real component code (from Storybook or a bare package) and uploads it. Use when the user runs /design-sync or says "sync my design system to Claude Design".'

// Keep the converter lazy, like the audited 2.1.221 bundled command. The .mjs
// files are data assets, not imports to execute inside the CLI process.
const loadContent = () => import('../../skills/bundled/designSyncContent.js')

const command = createBundledSkillCommand({
  name: 'design-sync',
  description: 'Push your design system components to claude.ai/design',
  argumentHint: '[<project hint, e.g. "Acme DS">]',
  whenToUse: DESCRIPTION,
  disableModelInvocation: true,
  userInvocable: true,
  isEnabled: () => designGateFailure() === null,
  files: async () => (await loadContent()).SKILL_FILES,
  async getPromptForCommand(args: string) {
    const { SKILL_MD } = await loadContent()
    const sections = [parseFrontmatter(SKILL_MD).content.trimStart()]
    // Only the web link origin is adapted for a host-managed deployment.
    // Never expose the internal Design RPC base to the model or rewrite the
    // audited converter assets; the tool still owns transport and auth.
    const webOrigin = getOauthConfig().CLAUDE_AI_ORIGIN
    if (webOrigin !== 'https://claude.ai') {
      sections.unshift(
        `Deployment link mapping: in the bundled instructions and reference files, ` +
          `https://claude.ai/design refers to ${webOrigin}/design. ` +
          `Use this deployment's web origin for project links. Use DesignSync for API calls.`,
      )
    }
    const hint = args.trim()
    if (hint) sections.push(`## Hint\n\n\`\`\`\n${hint}\n\`\`\``)
    return [{ type: 'text', text: sections.join('\n\n') }]
  },
})

export default command
