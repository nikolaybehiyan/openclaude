import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerRepoRoot, type RegisterRepoRootContext } from './registerRepoRoot.js'

describe('register_repo_root 2.1.221', () => {
  let temp: string
  let cwd: string
  let repository: string
  let context: RegisterRepoRootContext
  let directories: Map<string, { path: string; source: string }>
  let calls: string[]
  beforeEach(async () => {
    temp = await realpath(await mkdtemp(join(tmpdir(), 'register-repo-root-')))
    cwd = join(temp, 'workspace')
    repository = join(cwd, 'repo')
    await mkdir(repository, { recursive: true })
    directories = new Map()
    calls = []
    context = {
      cwd, getDirectories: () => directories,
      addDirectory: directory => { directories.set(directory, { path: directory, source: 'session' }); calls.push('add') },
      refreshSandbox: () => { calls.push('sandbox') },
      directoryAdded: () => { calls.push('hook') },
      reloadClaudeMd: () => { calls.push('claude.md') },
      reloadSkills: () => { calls.push('skills') },
      reloadPlugins: async () => { calls.push('plugins') },
    }
  })
  afterEach(async () => { await rm(temp, { recursive: true, force: true }) })

  test('registers canonical root and reloads requested components in order', async () => {
    await symlink(repository, join(cwd, 'alias'))
    expect(await registerRepoRoot({ directory: join(cwd, 'alias'), reload_claude_md: true, reload_skills: true, reload_plugins: true }, context)).toEqual({ directory: repository })
    expect(calls).toEqual(['add', 'sandbox', 'hook', 'claude.md', 'skills', 'plugins'])
  })
  test('reload flags are opt-in; repeat does not run hooks or reload', async () => {
    await registerRepoRoot({ directory: repository }, context)
    expect(calls).toEqual(['add', 'sandbox', 'hook'])
    await expect(registerRepoRoot({ directory: repository, reload_plugins: true }, context)).rejects.toThrow('already a registered')
    expect(calls).toEqual(['add', 'sandbox', 'hook'])
  })
  test('rejects cwd, parent, prefix sibling and nonexistent paths', async () => {
    const sibling = `${cwd}-sibling`
    await mkdir(sibling)
    for (const directory of [cwd, temp, sibling, join(cwd, 'missing')]) {
      await expect(registerRepoRoot({ directory }, context)).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })
  test('rejects files and symlink escapes', async () => {
    await writeFile(join(cwd, 'file'), 'not a directory')
    await symlink(temp, join(cwd, 'escape'))
    for (const directory of [join(cwd, 'file'), join(cwd, 'escape')]) {
      await expect(registerRepoRoot({ directory }, context)).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })
  test('allows strict children of a canonical launch-time add-dir', async () => {
    const external = join(temp, 'external')
    const child = join(external, 'repo')
    await mkdir(child, { recursive: true })
    const alias = join(temp, 'launch-alias')
    await symlink(external, alias)
    directories.set(alias, { path: alias, source: 'cliArg' })
    expect(await registerRepoRoot({ directory: child }, context)).toEqual({ directory: child })
    await expect(registerRepoRoot({ directory: external }, context)).rejects.toThrow('already a registered')
  })
  test('session-added directories cannot extend registration authority', async () => {
    const external = join(temp, 'external')
    const child = join(external, 'repo')
    await mkdir(child, { recursive: true })
    directories.set(external, { path: external, source: 'session' })
    await expect(registerRepoRoot({ directory: child }, context)).rejects.toThrow('not a subdirectory')
    expect(calls).toEqual([])
  })
  test('concurrent aliases register once and fire one hook', async () => {
    await symlink(repository, join(cwd, 'alias'))
    const results = await Promise.allSettled([repository, join(cwd, 'alias')].map(directory => registerRepoRoot({ directory }, context)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(calls).toEqual(['add', 'sandbox', 'hook'])
  })
  test('does not acknowledge before requested plugin refresh finishes', async () => {
    let release!: () => void
    context.reloadPlugins = () => new Promise(resolve => { release = resolve })
    let acknowledged = false
    const work = registerRepoRoot({ directory: repository, reload_plugins: true }, context).then(() => { acknowledged = true })
    while (!release) await Bun.sleep(1)
    expect(acknowledged).toBe(false)
    release()
    await work
    expect(acknowledged).toBe(true)
  })
})
