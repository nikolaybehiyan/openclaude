import { expect, test } from 'bun:test'
import { readFile } from 'fs/promises'

const sourcePath = new URL('./memory.ts', import.meta.url)

test('SDK memory edit prompts add only request data blocks over native auto-memory instructions', async () => {
  const source = await readFile(sourcePath, 'utf8')

  expect(source).toContain('scanMemoryFiles')
  expect(source).toContain('formatMemoryManifest')
  expect(source).toContain('buildExtractAutoOnlyPrompt')
  expect(source).toContain('## Requested memory edit')
  expect(source).toContain('## Desired memory edits')

  const forbiddenWrapperPolicy = [
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

test('SDK memory tool permission uses explicit hydrated memory dir for writes', async () => {
  const source = await readFile(sourcePath, 'utf8')

  expect(source).toContain('createAutoMemCanUseTool(memoryDir)')
  expect(source).toContain('isPathInsideMemoryDir(toolInput.file_path, memoryDir, cwd)')
  expect(source).toContain('isAbsolute(value) ? value : resolve(cwd, value)')
  expect(source).toContain('FILE_EDIT_TOOL_NAME')
  expect(source).toContain('FILE_WRITE_TOOL_NAME')
})

test('SDK memory edit forks start from native memory context, not chat context', async () => {
  const source = await readFile(sourcePath, 'utf8')

  expect(source).toContain('buildAutoMemoryEditCacheSafeParams(options.memoryRoot')
  expect(source).toContain('const memoryTools = getTools(buildPermissionContext')
  expect(source).toContain('mcpClients: []')
  expect(source).toContain('forkContextMessages: []')
  expect(source).not.toContain('getLastCacheSafeParams')
  expect(source).not.toContain('overrides:')
})
