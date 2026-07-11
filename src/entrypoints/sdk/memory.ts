import { getTools } from '../../tools.js'
import { readdir, readFile } from 'fs/promises'
import { basename, isAbsolute, join, normalize, resolve, sep } from 'path'
import { ENTRYPOINT_NAME } from '../../memdir/memdir.js'
import {
  getAutoMemPath,
  isAutoMemoryEnabled,
  isExtractModeActive,
} from '../../memdir/paths.js'
import { buildConsolidationPrompt } from '../../services/autoDream/consolidationPrompt.js'
import { readLastConsolidatedAt } from '../../services/autoDream/consolidationLock.js'
import { initAutoDream } from '../../services/autoDream/autoDream.js'
import {
  getIsNonInteractiveSession,
  getIsRemoteMode,
} from '../../bootstrap/state.js'
import {
  createAutoMemoryForkOptions,
  createAutoMemCanUseTool,
  drainPendingExtraction,
  initExtractMemories,
} from '../../services/extractMemories/extractMemories.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import type { Tools, ToolUseContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
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

export type AutoMemoryProjectionEntry = {
  line_number: number
  text: string
  file: string
  source_line: number
  name?: string
  description?: string
  type?: string
}

export type AutoMemoryProjection = {
  memory: string
  controls: string[]
  entries: AutoMemoryProjectionEntry[]
  files: string[]
}

export type AutoMemoryRuntimeState = {
  autoMemoryEnabled: boolean
  extractModeActive: boolean
  isRemoteMode: boolean
  isNonInteractiveSession: boolean
  autoMemPath: string
}

let autoMemoryLifecycleInitialized = false

export function unstable_initAutoMemoryLifecycle(): void {
  if (autoMemoryLifecycleInitialized) {
    return
  }
  initExtractMemories()
  initAutoDream()
  autoMemoryLifecycleInitialized = true
}

export async function unstable_drainAutoMemoryExtraction(timeoutMs?: number): Promise<void> {
  await drainPendingExtraction(timeoutMs)
}

export function unstable_getAutoMemoryRuntimeState(): AutoMemoryRuntimeState {
  return {
    autoMemoryEnabled: isAutoMemoryEnabled(),
    extractModeActive: isExtractModeActive(),
    isRemoteMode: getIsRemoteMode(),
    isNonInteractiveSession: getIsNonInteractiveSession(),
    autoMemPath: getAutoMemPath(),
  }
}

export async function unstable_didAutoDreamFireSince(sinceMs: number): Promise<boolean> {
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) {
    return false
  }
  return (await readLastConsolidatedAt()) >= sinceMs
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
  const cwd = options.cwd || process.cwd()
  const permissionContext = buildPermissionContext({
    cwd,
    permissionMode: 'acceptEdits',
  })
  const tools = getTools(permissionContext)
  const toolsByName = new Map(tools.map(tool => [tool.name, tool]))
  const toolUseContext = createAutoMemoryToolUseContext(tools)
  const canUseTool = createAutoMemCanUseTool(memoryDir)
  return async (name, input) => {
    const tool = toolsByName.get(name)
    if (!tool) {
      return {
        behavior: 'deny',
        message: `Tool ${name} is unavailable during auto-memory consolidation.`,
      }
    }
    const toolInput = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {}
    if (isMemoryWriteTool(name) && isPathInsideMemoryDir(toolInput.file_path, memoryDir, cwd)) {
      return { behavior: 'allow', updatedInput: input }
    }
    const result = await canUseTool(
      tool,
      toolInput,
      toolUseContext,
      {} as AssistantMessage,
      'auto-memory-sdk-boundary',
    )
    if (result.behavior !== 'allow') {
      return {
        behavior: 'deny',
        message: 'message' in result ? result.message : `Tool ${name} is denied during auto-memory consolidation.`,
      }
    }
    return {
      behavior: result.behavior,
      updatedInput: 'updatedInput' in result ? result.updatedInput : input,
    }
  }
}

export function unstable_getAutoMemoryToolNames(): string[] {
  const tools = getTools(buildPermissionContext({
    cwd: process.cwd(),
    permissionMode: 'acceptEdits',
  }))
  const context = createAutoMemoryToolUseContext(tools)
  return createAutoMemoryForkOptions(context.options).tools.map(tool => tool.name)
}

function isMemoryWriteTool(name: string): boolean {
  return name === FILE_EDIT_TOOL_NAME || name === FILE_WRITE_TOOL_NAME
}

function isPathInsideMemoryDir(value: unknown, memoryDir: string, cwd: string): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const root = normalize(memoryDir).replace(new RegExp(`${escapeRegExp(sep)}+$`), '')
  const candidate = normalize(isAbsolute(value) ? value : resolve(cwd, value))
  return candidate === root || candidate.startsWith(root + sep)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createAutoMemoryToolUseContext(tools: Tools, parentContext?: ToolUseContext): ToolUseContext {
  const appState = getDefaultAppState()
  const mainLoopModel = parentContext?.options.mainLoopModel ||
    (typeof appState.mainLoopModel === 'string' ? appState.mainLoopModel : '')
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel,
      tools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      providerOverride: parentContext?.options.providerOverride,
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }
}

export async function unstable_readAutoMemoryProjection(memoryRoot: string): Promise<string> {
  return (await unstable_readAutoMemoryProjectionDetails(memoryRoot)).memory
}

export async function unstable_readAutoMemoryProjectionDetails(
  memoryRoot: string,
): Promise<AutoMemoryProjection> {
  const index = await readMemoryIndex(memoryRoot)
  const files = await listMemoryTopicFiles(memoryRoot)
  const ordered = orderTopicFiles(index, files)
  const entries: AutoMemoryProjectionEntry[] = []
  const memoryBlocks: string[] = []
  for (const file of ordered) {
    const raw = await readFile(join(memoryRoot, ...file.split('/')), 'utf8')
    const parsed = parseFrontmatter(raw, file)
    const content = parsed.content.trim()
    if (content) {
      memoryBlocks.push(content)
      entries.push({
        line_number: entries.length + 1,
        text: content,
        file,
        source_line: 1,
        name: frontmatterString(parsed.frontmatter.name),
        description: frontmatterString(parsed.frontmatter.description),
        type: frontmatterString(parsed.frontmatter.type),
      })
    }
  }
  const controls = entries.map(entry => entry.text)
  const memory = memoryBlocks.join('\n\n')
  return {
    memory,
    controls,
    entries,
    files: ordered,
  }
}

async function readMemoryIndex(memoryRoot: string): Promise<string> {
  try {
    return (await readFile(join(memoryRoot, ENTRYPOINT_NAME), 'utf8')).trim()
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return ''
    }
    throw error
  }
}

async function listMemoryTopicFiles(memoryRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(memoryRoot, { recursive: true })
    return entries
      .map(entry => String(entry).split(sep).join('/'))
      .filter(entry => entry.endsWith('.md') && basename(entry) !== ENTRYPOINT_NAME)
      .filter(entry => entry.split('/').length <= 3)
      .sort((a, b) => a.localeCompare(b))
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function orderTopicFiles(index: string, files: string[]): string[] {
  const fileSet = new Set(files)
  const ordered: string[] = []
  for (const link of memoryIndexLinks(index)) {
    if (fileSet.has(link) && !ordered.includes(link)) {
      ordered.push(link)
    }
  }
  return ordered
}

function memoryIndexLinks(markdown: string): string[] {
  const links: string[] = []
  let position = 0
  while (position < markdown.length) {
    const open = markdown.indexOf('](', position)
    if (open === -1) break
    const start = open + 2
    const end = markdown.indexOf(')', start)
    if (end === -1) break
    const target = markdown.slice(start, end).trim()
    if (
      target.endsWith('.md') &&
      !target.startsWith('/') &&
      !target.startsWith('../') &&
      !target.includes('://')
    ) {
      links.push(target.split('\\').join('/'))
    }
    position = end + 1
  }
  return links
}

function frontmatterString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
