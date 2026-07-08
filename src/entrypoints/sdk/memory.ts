import { getTools } from '../../tools.js'
import { readdir, readFile, unlink, writeFile } from 'fs/promises'
import { basename, isAbsolute, join, normalize, resolve, sep } from 'path'
import { buildMemoryPrompt, ENTRYPOINT_NAME } from '../../memdir/memdir.js'
import {
  formatMemoryManifest,
  scanMemoryFiles,
} from '../../memdir/memoryScan.js'
import { buildConsolidationPrompt } from '../../services/autoDream/consolidationPrompt.js'
import { readLastConsolidatedAt } from '../../services/autoDream/consolidationLock.js'
import {
  createAutoMemCanUseTool,
  drainPendingExtraction,
} from '../../services/extractMemories/extractMemories.js'
import { buildExtractAutoOnlyPrompt } from '../../services/extractMemories/prompts.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getFlagSettingsInline, setFlagSettingsInline } from '../../bootstrap/state.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import type { Tools, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { Message } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import {
  createUserMessage,
  getMessagesAfterCompactBoundary,
} from '../../utils/messages.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { init } from '../init.js'
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

export type AutoMemoryEditCommand = 'add' | 'replace' | 'remove'

export type AutoMemoryEditRunOptions = {
  memoryRoot: string
  command?: AutoMemoryEditCommand
  control?: string
  line_number?: number
  replacement?: string
  projection?: AutoMemoryProjection
  controls?: string[]
  toolUseContext?: ToolUseContext
  settings?: Record<string, unknown>
  maxTurns?: number
}

export type AutoMemoryEditRunResult = {
  messages: Message[]
  writtenPaths: string[]
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

export async function unstable_applyAutoMemoryEdit(
  options: AutoMemoryEditRunOptions,
): Promise<AutoMemoryEditRunResult> {
  await init()
  const memoryRoot = withTrailingSeparator(options.memoryRoot)
  return await runWithCwdOverride(memoryRoot, async () => {
    const restoreSettings = applyAutoMemoryEditSettings(options.settings)
    try {
      const prePrunedPaths = await pruneEmptyMemoryTopics(memoryRoot)
      const cacheSafeParams = await buildAutoMemoryEditCacheSafeParams(
        memoryRoot,
        options.toolUseContext,
      )
      const prompt = await buildAutoMemoryEditExtractionPrompt(memoryRoot)
      const result = await runForkedAgent({
        promptMessages: [createUserMessage({ content: prompt })],
        cacheSafeParams: {
          ...cacheSafeParams,
          forkContextMessages: autoMemoryEditSourceMessages(
            options,
            cacheSafeParams.forkContextMessages,
          ),
        },
        canUseTool: createAutoMemCanUseTool(memoryRoot),
        querySource: 'extract_memories',
        forkLabel: 'extract_memories',
        skipTranscript: true,
        maxTurns: options.maxTurns ?? 5,
      })
      const postPrunedPaths = await pruneEmptyMemoryTopics(memoryRoot)
      return {
        messages: result.messages,
        writtenPaths: [
          ...new Set([
            ...extractWrittenPaths(result.messages, memoryRoot),
            ...prePrunedPaths,
            ...postPrunedPaths,
          ]),
        ],
        usage: result.totalUsage as unknown as Record<string, unknown>,
      }
    } finally {
      restoreSettings()
    }
  })
}

function applyAutoMemoryEditSettings(settings?: Record<string, unknown>): () => void {
  if (!settings || Object.keys(settings).length === 0) {
    return () => {}
  }
  const previous = getFlagSettingsInline()
  setFlagSettingsInline(settings)
  settingsChangeDetector.notifyChange('flagSettings')
  return () => {
    setFlagSettingsInline(previous)
    settingsChangeDetector.notifyChange('flagSettings')
  }
}

function autoMemoryEditSourceMessages(
  options: AutoMemoryEditRunOptions,
  contextMessages: Message[],
): Message[] {
  if (contextMessages.length > 0) {
    return contextMessages
  }
  return [createUserMessage({ content: buildManagedAutoMemoryEditEvent(options) })]
}

function buildManagedAutoMemoryEditEvent(options: AutoMemoryEditRunOptions): string {
  if (Array.isArray(options.controls)) {
    return JSON.stringify({
      type: 'memory_ui_edit_event',
      controls: options.controls,
    })
  }
  const projection = options.projection
  const entries = projection?.entries ?? []
  const target = options.line_number
    ? entries.find(entry => entry.line_number === options.line_number)
    : undefined
  if (!options.command) {
    throw new Error('auto_memory_edit_command_required')
  }
  if (options.command === 'add') {
    return JSON.stringify({
      type: 'memory_ui_edit_event',
      command: 'add',
      control: options.control?.trim() ?? '',
    })
  }
  if (options.command === 'replace') {
    return JSON.stringify({
      type: 'memory_ui_edit_event',
      command: 'replace',
      line_number: options.line_number ?? null,
      old_text: target?.text ?? '',
      replacement: options.replacement?.trim() ?? '',
    })
  }
  if (options.command === 'remove') {
    return JSON.stringify({
      type: 'memory_ui_edit_event',
      command: 'remove',
      line_number: options.line_number ?? null,
      old_text: target?.text ?? '',
    })
  }
  throw new Error('auto_memory_edit_command_unsupported')
}

async function buildAutoMemoryEditExtractionPrompt(memoryRoot: string): Promise<string> {
  const manifest = formatMemoryManifest(
    await scanMemoryFiles(memoryRoot, new AbortController().signal),
  )
  return buildExtractAutoOnlyPrompt(1, manifest)
}

async function buildAutoMemoryEditCacheSafeParams(memoryRoot: string, parentContext?: ToolUseContext): Promise<CacheSafeParams> {
  const memoryTools = getTools(buildPermissionContext({
    cwd: memoryRoot,
    permissionMode: 'acceptEdits',
  }))
  const toolUseContext = createAutoMemoryToolUseContext(memoryTools, parentContext)
  const memoryPrompt = buildMemoryPrompt({
    displayName: 'auto memory',
    memoryDir: memoryRoot,
  })
  return {
    systemPrompt: asSystemPrompt([memoryPrompt]),
    userContext: {},
    systemContext: {},
    toolUseContext,
    forkContextMessages: parentContext
      ? getMessagesAfterCompactBoundary(stripInProgressAssistantMessage(parentContext.messages ?? []))
      : [],
  }
}

function stripInProgressAssistantMessage(messages: Message[]): Message[] {
  const last = messages.at(-1)
  if (last?.type === 'assistant' && last.message.stop_reason === null) {
    return messages.slice(0, -1)
  }
  return messages
}

async function pruneEmptyMemoryTopics(memoryRoot: string): Promise<string[]> {
  const emptyFiles: string[] = []
  for (const file of await listMemoryTopicFiles(memoryRoot)) {
    const raw = await readFile(join(memoryRoot, ...file.split('/')), 'utf8')
    const parsed = parseFrontmatter(raw, file)
    if (!parsed.content.trim()) {
      emptyFiles.push(file)
    }
  }
  if (emptyFiles.length === 0) {
    return []
  }
  for (const file of emptyFiles) {
    await unlinkIfExists(join(memoryRoot, ...file.split('/')))
  }
  await pruneMemoryIndexLinks(memoryRoot, new Set(emptyFiles))
  return emptyFiles.map(file => join(memoryRoot, ...file.split('/')))
}

async function pruneMemoryIndexLinks(memoryRoot: string, removedFiles: Set<string>): Promise<void> {
  const index = await readMemoryIndex(memoryRoot)
  if (!index) {
    return
  }
  const keptLines = index
    .split(/\r?\n/)
    .filter(line => !memoryIndexLinks(line).some(link => removedFiles.has(link)))
  const hasTopicLinks = keptLines.some(line => memoryIndexLinks(line).length > 0)
  if (!hasTopicLinks) {
    await unlinkIfExists(join(memoryRoot, ENTRYPOINT_NAME))
    return
  }
  await writeFile(
    join(memoryRoot, ENTRYPOINT_NAME),
    `${keptLines.join('\n').trim()}\n`,
    'utf8',
  )
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      throw error
    }
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

function withTrailingSeparator(memoryRoot: string): string {
  const normalized = normalize(memoryRoot)
  return normalized.endsWith(sep) ? normalized : normalized + sep
}

function extractWrittenPaths(messages: Message[], memoryRoot: string): string[] {
  const paths: string[] = []
  for (const message of messages) {
    if (message.type !== 'assistant') {
      continue
    }
    const content = (message as AssistantMessage).message.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      const filePath = writtenFilePath(block)
      if (filePath && isPathInsideMemoryDir(filePath, memoryRoot, memoryRoot)) {
        paths.push(filePath)
      }
    }
  }
  return [...new Set(paths)]
}

function writtenFilePath(block: unknown): string | undefined {
  if (
    !block ||
    typeof block !== 'object' ||
    (block as { type?: unknown }).type !== 'tool_use'
  ) {
    return undefined
  }
  const name = (block as { name?: unknown }).name
  if (name !== FILE_EDIT_TOOL_NAME && name !== FILE_WRITE_TOOL_NAME) {
    return undefined
  }
  const input = (block as { input?: unknown }).input
  if (!input || typeof input !== 'object' || !('file_path' in input)) {
    return undefined
  }
  const value = (input as { file_path?: unknown }).file_path
  return typeof value === 'string' ? value : undefined
}
