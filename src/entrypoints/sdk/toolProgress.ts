import type { SDKMessage } from './shared.js'
import { tailFile } from '../../utils/fsOperations.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'

const TOOL_PROGRESS_OUTPUT_TAIL_BYTES = 16 * 1024

export async function hydrateToolProgressOutput(
  message: SDKMessage,
): Promise<SDKMessage> {
  if (message.type !== 'tool_progress' || !message.task_id) {
    return message
  }
  if (typeof message.output === 'string' && message.output.length > 0) {
    return message
  }

  try {
    const output = await tailFile(
      getTaskOutputPath(message.task_id),
      TOOL_PROGRESS_OUTPUT_TAIL_BYTES,
    )
    if (!output.content) {
      return message
    }
    return {
      ...message,
      content: output.content,
      output: output.content,
      total_bytes: output.bytesTotal,
      output_truncated: output.bytesTotal > output.bytesRead,
    }
  } catch {
    return message
  }
}
