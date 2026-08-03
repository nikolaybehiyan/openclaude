import { z } from 'zod/v4'
import { queryHaiku } from '../services/api/claude.js'
import { truncateToWidth } from './format.js'
import { safeParseJSON } from './json.js'
import { logError } from './log.js'
import { asSystemPrompt } from './systemPromptType.js'

const SESSION_TITLE_AND_BRANCH_PROMPT = `You are coming up with a succinct title and git branch name for a coding session based on the provided description. The title should be clear, concise, and accurately reflect the content of the coding task.
You should keep it short and simple, ideally no more than 6 words. Avoid using jargon or overly technical terms unless absolutely necessary. The title should be easy to understand for anyone reading it.
Use sentence case for the title (capitalize only the first word and proper nouns), not Title Case.

The branch name should be clear, concise, and accurately reflect the content of the coding task.
You should keep it short and simple, ideally no more than 4 words. The branch should always start with "claude/" and should be all lower case, with words separated by dashes.

Return a JSON object with "title" and "branch" fields.

Example 1: {"title": "Fix login button not working on mobile", "branch": "claude/fix-mobile-login-button"}
Example 2: {"title": "Update README with installation instructions", "branch": "claude/update-readme"}
Example 3: {"title": "Improve performance of data processing script", "branch": "claude/improve-data-processing"}

Here is the session description:
<description>{description}</description>
Please generate a title and branch name for this session.`

export type SessionTitleAndBranch = {
  title: string
  branchName: string
}

export function fallbackSessionTitleAndBranch(
  description: string,
): SessionTitleAndBranch {
  return {
    title: truncateToWidth(description, 75),
    branchName: 'claude/task',
  }
}

export function parseSessionTitleAndBranch(
  text: string,
  fallback: SessionTitleAndBranch,
): SessionTitleAndBranch {
  const parsed = safeParseJSON(text.trim())
  const result = z
    .object({
      title: z.string(),
      branch: z.string(),
    })
    .safeParse(parsed)
  if (!result.success) return fallback
  return {
    title: result.data.title || fallback.title,
    branchName: result.data.branch || fallback.branchName,
  }
}

/**
 * Generate the source-compatible title and branch pair used by remote Code.
 * This is the extracted implementation previously private to teleport.tsx.
 */
export async function generateTitleAndBranch(
  description: string,
  signal: AbortSignal,
): Promise<SessionTitleAndBranch> {
  const fallback = fallbackSessionTitleAndBranch(description)
  try {
    const userPrompt = SESSION_TITLE_AND_BRANCH_PROMPT.replace(
      '{description}',
      description,
    )
    const response = await queryHaiku({
      systemPrompt: asSystemPrompt([]),
      userPrompt,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            branch: { type: 'string' },
          },
          required: ['title', 'branch'],
          additionalProperties: false,
        },
      },
      signal,
      options: {
        querySource: 'teleport_generate_title',
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    const firstBlock = response.message.content[0]
    if (firstBlock?.type !== 'text') return fallback
    return parseSessionTitleAndBranch(firstBlock.text, fallback)
  } catch (error) {
    logError(new Error(`Error generating title and branch: ${error}`))
    return fallback
  }
}
