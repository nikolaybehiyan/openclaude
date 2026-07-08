import { expect, test } from 'bun:test'
import { readFile } from 'fs/promises'

const sourcePath = new URL('./memory.ts', import.meta.url)

test('SDK memory edits reuse native extraction prompt without custom memory instructions', async () => {
  const source = await readFile(sourcePath, 'utf8')

  expect(source).toContain('buildMemoryPrompt')
  expect(source).toContain('buildExtractAutoOnlyPrompt')
  expect(source).toContain('scanMemoryFiles')
  expect(source).toContain('formatMemoryManifest')
  expect(source).toContain('runForkedAgent')
  expect(source).toContain('buildManagedAutoMemoryEditEvent')
  expect(source).toContain('autoMemoryEditSourceMessages')

  const forbiddenWrapperPolicy = [
    'unstable_runAutoMemoryUserEdit',
    'unstable_buildAutoMemoryUserEditPrompt',
    'unstable_buildAutoMemoryControlsEditPrompt',
    'unstable_buildAutoMemoryEditPrompt',
    ['buildAutoMemoryEdit', 'Request'].join(''),
    '## Memory edit request',
    'Command: set_visible_memory_entries',
    ['Please', 'remember'].join(' '),
    ['Please', 'forget'].join(' '),
    ['Remember', ':'].join(''),
    ['Forget', 'this'].join(' '),
    ['Forget', 'all'].join(' '),
    ['Remember', 'these'].join(' '),
    ['The user added', 'a visible memory edit'].join(' '),
    ['The user replaced', 'a visible memory edit'].join(' '),
    ['The user removed', 'this visible memory edit'].join(' '),
    ['The user edited', 'visible memory'].join(' '),
    ['The user cleared all', 'visible memory edits'].join(' '),
    ['Current projected', 'memory edits'].join(' '),
    ['Apply exactly this requested edit', 'to the native memory tree.'].join(' '),
    ['Use Read/Edit/Write only', 'inside the memory directory.'].join(' '),
    ['Update the relevant topic file', 'when possible'].join(' '),
    ['Reconcile the native', 'memory tree'].join(' '),
    ['Update existing topic files', 'where possible'].join(' '),
    ['After editing files, respond', 'with a short confirmation only.'].join(' '),
  ]

  for (const forbidden of forbiddenWrapperPolicy) {
    expect(source).not.toContain(forbidden)
  }
})

test('SDK memory projection keeps summary markdown separate from numbered edit controls', async () => {
  const source = await readFile(sourcePath, 'utf8')

  expect(source).toContain('const memory = memoryBlocks.join')
  expect(source).not.toContain("controls.map((text, index) => `${index + 1}. ${text}`).join('\\n')")
  expect(source).not.toContain('projectionLinesFromTopic')
  expect(source).not.toContain('normalizeMemoryProjectionLine')
})

test('SDK memory edits prune empty topic artifacts before rebuilding native prompts', async () => {
  const source = await readFile(sourcePath, 'utf8')

  expect(source).toContain('const prePrunedPaths = await pruneEmptyMemoryTopics(memoryRoot)')
  expect(source).toContain('const postPrunedPaths = await pruneEmptyMemoryTopics(memoryRoot)')
  expect(source).toContain('if (!parsed.content.trim())')
  expect(source).toContain('await unlinkIfExists(join(memoryRoot, ...file.split')
  expect(source).toContain('filter(line => !memoryIndexLinks(line).some')
  expect(source).toContain('if (!hasTopicLinks)')
  expect(source).toContain('await unlinkIfExists(join(memoryRoot, ENTRYPOINT_NAME))')
  expect((source.match(/await unlinkIfExists\(join\(memoryRoot, ENTRYPOINT_NAME\)\)/g) ?? []).length).toBe(2)
  expect(source).not.toContain('hasTopicLinks ? `${keptLines.join')
})

test('SDK memory tool permission uses explicit hydrated memory dir for writes', async () => {
  const source = await readFile(sourcePath, 'utf8')

  expect(source).toContain('createAutoMemCanUseTool(memoryDir)')
  expect(source).toContain('isPathInsideMemoryDir(toolInput.file_path, memoryDir, cwd)')
  expect(source).toContain('isAbsolute(value) ? value : resolve(cwd, value)')
  expect(source).toContain('FILE_EDIT_TOOL_NAME')
  expect(source).toContain('FILE_WRITE_TOOL_NAME')
})

test('SDK memory edit forks use chat messages with native memory tools only', async () => {
  const source = await readFile(sourcePath, 'utf8')

  expect(source).toContain('buildAutoMemoryEditCacheSafeParams(')
  expect(source).toContain('const memoryTools = getTools(buildPermissionContext')
  expect(source).toContain('promptMessages: [createUserMessage({ content: prompt })]')
  expect(source).toContain('forkContextMessages: autoMemoryEditSourceMessages(')
  expect(source).toContain('const eventMessage = createUserMessage({ content: buildManagedAutoMemoryEditEvent(options) })')
  expect(source).toContain('if (contextMessages.length > 0)')
  expect(source).toContain('return contextMessages')
  expect(source).not.toContain('return [...contextMessages, eventMessage]')
  expect(source).not.toContain('...cacheSafeParams.forkContextMessages,\n            requestMessage')
  expect(source).toContain('mcpClients: []')
  expect(source).toContain('getMessagesAfterCompactBoundary')
  expect(source).not.toContain('getLastCacheSafeParams')
  expect(source).not.toContain('overrides:')
})
