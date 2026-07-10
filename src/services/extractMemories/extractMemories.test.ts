import { expect, test } from 'bun:test'
import { readFile } from 'fs/promises'

const extractMemoriesPath = new URL('./extractMemories.ts', import.meta.url)
const autoDreamPath = new URL('../autoDream/autoDream.ts', import.meta.url)

test('native memory forks expose only memory-safe tools', async () => {
  const [extractSource, dreamSource] = await Promise.all([
    readFile(extractMemoriesPath, 'utf8'),
    readFile(autoDreamPath, 'utf8'),
  ])

  expect(extractSource).toContain('const AUTO_MEMORY_FORK_TOOL_NAMES = new Set')
  expect(extractSource).toContain('FILE_READ_TOOL_NAME')
  expect(extractSource).toContain('FILE_EDIT_TOOL_NAME')
  expect(extractSource).toContain('FILE_WRITE_TOOL_NAME')
  expect(extractSource).toContain('GREP_TOOL_NAME')
  expect(extractSource).toContain('GLOB_TOOL_NAME')
  expect(extractSource).not.toContain('  BASH_TOOL_NAME,\n]')
  expect(extractSource).toContain('getTools(getEmptyToolPermissionContext())')
  expect(extractSource).toContain('options: createAutoMemoryForkOptions(cacheSafeParams.toolUseContext.options)')
  expect(dreamSource).toContain('createAutoMemoryForkOptions(cacheSafeParams.toolUseContext.options)')
})
