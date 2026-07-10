import { expect, test } from 'bun:test'
import { readFile } from 'fs/promises'

const sourcePath = new URL('./memory.ts', import.meta.url)
const indexPath = new URL('./index.ts', import.meta.url)
const sdkV2Path = new URL('./v2.ts', import.meta.url)

test('SDK memory boundary exposes native lifecycle helpers', async () => {
  const [source, index] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(indexPath, 'utf8'),
  ])

  for (const symbol of [
    'unstable_drainAutoMemoryExtraction',
    'unstable_didAutoDreamFireSince',
    'unstable_buildAutoMemoryConsolidationPrompt',
    'unstable_createAutoMemoryCanUseTool',
    'unstable_initAutoMemoryLifecycle',
    'unstable_readAutoMemoryProjectionDetails',
  ]) {
    expect(source).toContain(symbol)
    expect(index).toContain(symbol)
  }
})

test('SDK memory projection reads topic files and keeps MEMORY.md as ordering only', async () => {
  const source = await readFile(sourcePath, 'utf8')

  expect(source).toContain('const index = await readMemoryIndex(memoryRoot)')
  expect(source).toContain('const ordered = orderTopicFiles(index, files)')
  expect(source).toContain('memoryBlocks.push(content)')
  expect(source).toContain('const controls = entries.map(entry => entry.text)')
  expect(source).not.toContain('controls.map((text, index)')
})

test('SDK memory tool permission uses explicit hydrated memory dir for writes', async () => {
  const source = await readFile(sourcePath, 'utf8')

  expect(source).toContain('createAutoMemCanUseTool(memoryDir)')
  expect(source).toContain('isPathInsideMemoryDir(toolInput.file_path, memoryDir, cwd)')
  expect(source).toContain('isAbsolute(value) ? value : resolve(cwd, value)')
  expect(source).toContain('FILE_EDIT_TOOL_NAME')
  expect(source).toContain('FILE_WRITE_TOOL_NAME')
})

test('SDK native memory forks do not inherit SDK MCP runtime tools', async () => {
  const source = await readFile(sdkV2Path, 'utf8')

  expect(source).toContain('installSdkBackgroundForkToolIsolation()')
  expect(source).toContain("context.querySource !== 'sdk'")
  expect(source).toContain('isTerminalAssistantMessage')
  expect(source).toContain('tool.isMcp !== true')
})
