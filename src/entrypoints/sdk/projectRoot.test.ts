import { expect, test } from 'bun:test'
import { readFile } from 'fs/promises'

const v2SourcePath = new URL('./v2.ts', import.meta.url)
const querySourcePath = new URL('./query.ts', import.meta.url)

test('SDK sessions anchor OpenClaude project root to SDK cwd', async () => {
  const v2Source = await readFile(v2SourcePath, 'utf8')
  const querySource = await readFile(querySourcePath, 'utf8')

  expect(v2Source).toContain('setProjectRoot(cwd)')
  expect(querySource).toContain('setProjectRoot(cwd)')
})
