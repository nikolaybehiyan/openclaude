import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBundledSkills } from '../../skills/bundledSkills.js'
import manifest from '../../skills/bundled/design-sync/claude-code-2.1.221.manifest.json'
import { SKILL_FILES, SKILL_MD } from '../../skills/bundled/designSyncContent.js'
import command from './index.js'

const originalMacro = (globalThis as Record<string, unknown>).MACRO
beforeEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'design-sync-test' }
})
afterEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
})

test('/design-sync ships all 26 byte-exact audited skill assets', () => {
  const content = { 'SKILL.md': SKILL_MD, ...SKILL_FILES }
  expect(Object.keys(content).sort()).toEqual(Object.keys(manifest.assets).sort())
  expect(Object.keys(SKILL_FILES)).toHaveLength(25)
  for (const [path, evidence] of Object.entries(manifest.assets)) {
    const value = content[path as keyof typeof content]!
    expect(Buffer.byteLength(value)).toBe(evidence.bytes)
    expect(createHash('sha256').update(value).digest('hex')).toBe(evidence.sha256)
  }
})

test('text assets survive Bun bundling without executing converter imports', async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../skills/bundled/designSyncContent.ts')],
    target: 'bun',
    write: false,
  })
  expect(build.success).toBe(true)
  expect(build.outputs).toHaveLength(1)
  const source = await build.outputs[0]!.text()
  const dir = await mkdtemp(join(tmpdir(), 'design-sync-asset-bundle-'))
  const output = join(dir, 'content.mjs')
  await writeFile(output, source)
  const bundled = await import(pathToFileURL(output).href)
  expect(bundled.SKILL_MD).toBe(SKILL_MD)
  expect(bundled.SKILL_FILES).toEqual(SKILL_FILES)
})

test('hosted prompt maps project links to the public origin without exposing internal RPC routes', async () => {
  const previous = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
  try {
    const blocks = await command.getPromptForCommand('', {} as never)
    const prompt = (blocks[0] as { text: string }).text
    expect(prompt).toContain('https://claude.ai/design refers to https://ai.darbmind.ru/design')
    expect(prompt).not.toContain('svc.cluster.local')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
    else process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = previous
  }
})

test('/design-sync expands the full skill and extracts executable resource names once', async () => {
  const [first, second] = await Promise.all([
    command.getPromptForCommand('  One-component private fixture  ', {} as never),
    command.getPromptForCommand('', {} as never),
  ])
  expect(command.source).toBe('bundled')
  expect(command.disableModelInvocation).toBe(true)
  expect(command.userInvocable).toBe(true)
  expect(command.allowedTools).toEqual([])
  expect(getBundledSkills().filter(c => c.name === 'design-sync')).toHaveLength(0)
  for (const blocks of [first, second]) {
    expect(blocks[0]?.type).toBe('text')
    const prompt = (blocks[0] as { text: string }).text
    expect(prompt).toStartWith(`Base directory for this skill: ${command.skillRoot}\n\n`)
    expect(prompt).toContain('## 3. The incremental upload sequence')
    expect(prompt).toContain('package-build.mjs')
    expect(prompt).toContain('resync.mjs')
    expect(prompt).not.toContain('---\nname: design-sync')
  }
  expect((first[0] as { text: string }).text).toEndWith(
    '## Hint\n\n```\nOne-component private fixture\n```',
  )
  expect((second[0] as { text: string }).text).not.toContain('## Hint')
  for (const [path, content] of Object.entries(SKILL_FILES)) {
    const target = join(command.skillRoot!, path)
    expect(await readFile(target, 'utf8')).toBe(content)
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  }
})
