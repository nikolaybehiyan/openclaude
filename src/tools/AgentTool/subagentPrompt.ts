import { isEnvTruthy } from '../../utils/envUtils.js'
import { asSystemPrompt, type SystemPrompt } from '../../utils/systemPromptType.js'

/** 2.1.221: ordinary Task children inherit this; forks retain their exact prefix. */
export function appendSubagentPrompt(
  prompt: SystemPrompt,
  append: string | undefined,
  useExactTools: boolean,
): SystemPrompt {
  return !useExactTools && append && isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT)
    ? asSystemPrompt([...prompt, append])
    : prompt
}
