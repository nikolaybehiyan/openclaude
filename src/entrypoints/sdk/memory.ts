import { getTools } from '../../tools.js'
import { readdir, readFile } from 'fs/promises'
import { basename, isAbsolute, join, normalize, resolve, sep } from 'path'
import { ENTRYPOINT_NAME } from '../../memdir/memdir.js'
import {
  formatMemoryManifest,
  scanMemoryFiles,
} from '../../memdir/memoryScan.js'
import { buildConsolidationPrompt } from '../../services/autoDream/consolidationPrompt.js'
import { readLastConsolidatedAt } from '../../services/autoDream/consolidationLock.js'
import { createAutoMemCanUseTool, drainPendingExtraction } from '../../services/extractMemories/extractMemories.js'
import { buildExtractAutoOnlyPrompt } from '../../services/extractMemories/prompts.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import type { Tools, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { Message } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  getLastCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import {
  createUserMessage,
  extractTextContent,
  getLastAssistantMessage,
  getMessagesAfterCompactBoundary,
} from '../../utils/messages.js'
import { createAbortController } from '../../utils/abortController.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
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

export type AutoMemoryUserEditPromptOptions = {
  memoryRoot: string
  command: 'add' | 'replace' | 'remove'
  control?: string
  line_number?: number
  replacement?: string
  projection?: AutoMemoryProjection
}

export type AutoMemoryControlsEditPromptOptions = {
  memoryRoot: string
  controls: string[]
}

export type AutoMemoryUserEditRunOptions = AutoMemoryUserEditPromptOptions & {
  toolUseContext?: ToolUseContext
  maxTurns?: number
}

export type AutoMemoryUserEditRunResult = {
  messages: Message[]
  result: string | null
  usage: Record<string, unknown>
}

export async function unstable_drainAutoMemoryExtraction(timeoutMs?: number): Promise<void> {
  await drainPendingExtraction(timeoutMs)
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

function createAutoMemoryToolUseContext(tools: Tools): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: typeof appState.mainLoopModel === 'string' ? appState.mainLoopModel : '',
      tools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
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

export async function unstable_buildAutoMemoryUserEditPrompt(
  options: AutoMemoryUserEditPromptOptions,
): Promise<string> {
  const projection = options.projection
  const entries = projection?.entries ?? []
  const target = options.line_number
    ? entries.find(entry => entry.line_number === options.line_number)
    : undefined
  const lines = [
    await buildNativeAutoMemoryEditPreamble(options.memoryRoot),
    '',
    '## Requested memory edit',
    `Command: ${options.command}`,
  ]
  if (options.control) {
    lines.push(`Control: ${options.control}`)
  }
  if (options.replacement) {
    lines.push(`Replacement: ${options.replacement}`)
  }
  if (target) {
    lines.push(
      `Target: line ${target.line_number} in ${target.file}:${target.source_line}`,
      `Old text: ${target.text}`,
    )
  }
  return lines.join('\n')
}

export async function unstable_runAutoMemoryUserEdit(
  options: AutoMemoryUserEditRunOptions,
): Promise<AutoMemoryUserEditRunResult> {
  const prompt = await unstable_buildAutoMemoryUserEditPrompt(options)
  const cacheSafeParams = await buildAutoMemoryEditCacheSafeParams(options.toolUseContext)
  const result = await runWithCwdOverride(options.memoryRoot, () =>
    runForkedAgent({
      promptMessages: [createUserMessage({ content: prompt })],
      cacheSafeParams,
      canUseTool: createAutoMemCanUseTool(options.memoryRoot),
      querySource: 'memory_user_edits',
      forkLabel: 'memory_user_edits',
      skipTranscript: true,
      maxTurns: options.maxTurns ?? 5,
    }),
  )
  const assistant = getLastAssistantMessage(result.messages)
  const content = assistant?.message.content
  return {
    messages: result.messages,
    result: Array.isArray(content) ? extractTextContent(content) : null,
    usage: result.totalUsage as unknown as Record<string, unknown>,
  }
}

async function buildAutoMemoryEditCacheSafeParams(toolUseContext?: ToolUseContext): Promise<CacheSafeParams> {
  const saved = getLastCacheSafeParams()
  if (toolUseContext) {
    const forkContextMessages = getMessagesAfterCompactBoundary(stripInProgressAssistantMessage(toolUseContext.messages ?? []))
    if (saved) {
      return {
        systemPrompt: saved.systemPrompt,
        userContext: saved.userContext,
        systemContext: saved.systemContext,
        toolUseContext: {
          ...toolUseContext,
          abortController: createAbortController(),
        },
        forkContextMessages,
      }
    }
    const [rawSystemPrompt, userContext, systemContext] = await Promise.all([
      getSystemPrompt(
        toolUseContext.options.tools,
        toolUseContext.options.mainLoopModel,
        [],
        toolUseContext.options.mcpClients,
      ),
      getUserContext(),
      getSystemContext(),
    ])
    return {
      systemPrompt: asSystemPrompt(rawSystemPrompt),
      userContext,
      systemContext,
      toolUseContext: {
        ...toolUseContext,
        abortController: createAbortController(),
      },
      forkContextMessages,
    }
  }
  if (!saved) {
    throw new Error('OpenClaude auto-memory edit cache context is unavailable until a turn context exists')
  }
  return {
    ...saved,
    toolUseContext: {
      ...saved.toolUseContext,
      abortController: createAbortController(),
    },
  }
}

function stripInProgressAssistantMessage(messages: Message[]): Message[] {
  const last = messages.at(-1)
  if (last?.type === 'assistant' && last.message.stop_reason === null) {
    return messages.slice(0, -1)
  }
  return messages
}

export async function unstable_buildAutoMemoryControlsEditPrompt(
  options: AutoMemoryControlsEditPromptOptions,
): Promise<string> {
  return [
    await buildNativeAutoMemoryEditPreamble(options.memoryRoot),
    '',
    '## Desired memory edits',
    options.controls.length
      ? options.controls.map((control, index) => `${index + 1}. ${control}`).join('\n')
      : 'No memory edits should remain.',
  ].join('\n')
}

async function buildNativeAutoMemoryEditPreamble(memoryRoot: string): Promise<string> {
  const ac = new AbortController()
  const manifest = formatMemoryManifest(await scanMemoryFiles(memoryRoot, ac.signal))
  return buildExtractAutoOnlyPrompt(1, manifest)
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
  for (const file of files) {
    if (!ordered.includes(file)) {
      ordered.push(file)
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
