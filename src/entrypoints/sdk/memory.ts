import { getTools } from '../../tools.js'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { ENTRYPOINT_NAME } from '../../memdir/memdir.js'
import { buildConsolidationPrompt } from '../../services/autoDream/consolidationPrompt.js'
import { createAutoMemCanUseTool } from '../../services/extractMemories/extractMemories.js'
import { buildPermissionContext } from './permissions.js'
import type { CanUseToolCallback } from './shared.js'

export type AutoMemoryConsolidationPromptOptions = {
  memoryRoot: string
  transcriptDir: string
  extra?: string
}

export type AutoMemoryCanUseToolOptions = {
  cwd?: string
}

export function unstable_buildAutoMemoryConsolidationPrompt(
  options: AutoMemoryConsolidationPromptOptions,
): string {
  return buildConsolidationPrompt(
    options.memoryRoot,
    options.transcriptDir,
    options.extra ?? '',
  )
}

export function unstable_createAutoMemoryCanUseTool(
  memoryDir: string,
  options: AutoMemoryCanUseToolOptions = {},
): CanUseToolCallback {
  const permissionContext = buildPermissionContext({
    cwd: options.cwd || process.cwd(),
    permissionMode: 'acceptEdits',
  })
  const toolsByName = new Map(getTools(permissionContext).map(tool => [tool.name, tool]))
  const canUseTool = createAutoMemCanUseTool(memoryDir)
  return async (name, input) => {
    const tool = toolsByName.get(name)
    if (!tool) {
      return {
        behavior: 'deny',
        message: `Tool ${name} is unavailable during auto-memory consolidation.`,
      }
    }
    const result = await canUseTool(
      tool,
      input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {},
    )
    return {
      behavior: result.behavior,
      message: 'message' in result ? result.message : undefined,
      updatedInput: 'updatedInput' in result ? result.updatedInput : input,
    }
  }
}

export async function unstable_readAutoMemoryProjection(memoryRoot: string): Promise<string> {
  try {
    return (await readFile(join(memoryRoot, ENTRYPOINT_NAME), 'utf8')).trim()
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return ''
    }
    throw error
  }
}
