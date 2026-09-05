import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import {
  remoteSkillSyncEnabled,
  startRemotePluginSync,
  syncRemotePluginsOnce,
  syncRemoteSkillsOnce,
} from './remoteSkillSync.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path =>
      rm(path, { recursive: true, force: true }),
    ),
  )
})

describe('Remote account skill sync', () => {
  test('does not require the optional Remote upstream proxy flag', () => {
    const previousSync = process.env.CLAUDE_CODE_SYNC_SKILLS
    const previousRemote = process.env.CLAUDE_CODE_REMOTE
    try {
      process.env.CLAUDE_CODE_SYNC_SKILLS = '1'
      delete process.env.CLAUDE_CODE_REMOTE
      expect(remoteSkillSyncEnabled()).toBe(true)
    } finally {
      if (previousSync === undefined) delete process.env.CLAUDE_CODE_SYNC_SKILLS
      else process.env.CLAUDE_CODE_SYNC_SKILLS = previousSync
      if (previousRemote === undefined) delete process.env.CLAUDE_CODE_REMOTE
      else process.env.CLAUDE_CODE_REMOTE = previousRemote
    }
  })

  test('installs verified account skills and removes only stale managed skills', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'remote-skills-'))
    temporaryDirectories.push(configDir)
    await mkdir(join(configDir, 'skills', 'local-skill'), { recursive: true })
    await writeFile(
      join(configDir, 'skills', 'local-skill', 'SKILL.md'),
      '# Local\n',
    )

    const archive = Buffer.from(
      zipSync({
        'SKILL.md': strToU8('# Remote\n'),
        'references/readme.md': strToU8('reference\n'),
      }),
    )
    const digest = createHash('sha256').update(archive).digest('hex')
    let enabled = true
    const requests: Array<{ url: string; authorization: string | null }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      requests.push({
        url,
        authorization: headers.get('authorization'),
      })
      if (url.endsWith('/worker/skill-manifest')) {
        return Response.json({
          skills: enabled
            ? [
                {
                  id: 'skill-1',
                  name: 'Remote Skill',
                  description: 'Remote test skill',
                  version: digest,
                  directory: 'Remote-Skill-12345678',
                },
              ]
            : [],
          plugins: [{ id: 'must-never-install' }],
        })
      }
      return new Response(archive, {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-length': String(archive.length),
        },
      })
    }) as typeof fetch

    const options = {
      configDir,
      apiBaseURL: 'https://code.internal',
      sessionID: 'session-1',
      token: 'worker-token',
      fetchImpl,
      installTimeoutMs: 1000,
    }
    await syncRemoteSkillsOnce(options)
    expect(
      await readFile(
        join(configDir, 'skills', 'Remote-Skill-12345678', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# Remote\n')
    expect(
      await readFile(
        join(
          configDir,
          'skills',
          'Remote-Skill-12345678',
          'references',
          'readme.md',
        ),
        'utf8',
      ),
    ).toBe('reference\n')
    expect(
      JSON.parse(
        await readFile(join(configDir, 'skills', 'manifest.json'), 'utf8'),
      ),
    ).toEqual({
      version: 1,
      skills: [
        {
          id: 'skill-1',
          version: digest,
          directory: 'Remote-Skill-12345678',
        },
      ],
    })
    expect(requests.every(request => request.authorization === 'Bearer worker-token')).toBe(true)

    enabled = false
    await syncRemoteSkillsOnce(options)
    await expect(
      readFile(
        join(configDir, 'skills', 'Remote-Skill-12345678', 'SKILL.md'),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      await readFile(join(configDir, 'skills', 'local-skill', 'SKILL.md'), 'utf8'),
    ).toBe('# Local\n')
  })

  test('accepts one wrapper directory and rejects a digest mismatch', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'remote-skills-wrapper-'))
    temporaryDirectories.push(configDir)
    const archive = Buffer.from(
      zipSync({
        'wrapped/SKILL.md': strToU8('# Wrapped\n'),
        'wrapped/file.txt': strToU8('ok'),
      }),
    )
    const digest = createHash('sha256').update(archive).digest('hex')
    let expectedDigest = digest
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/worker/skill-manifest')) {
        return Response.json({
          skills: [
            {
              id: 'wrapped',
              name: 'Wrapped',
              version: expectedDigest,
              directory: 'Wrapped-12345678',
            },
          ],
          plugins: [],
        })
      }
      return new Response(archive, { status: 200 })
    }) as typeof fetch
    const options = {
      configDir,
      apiBaseURL: 'http://code.internal',
      sessionID: 'session-wrapper',
      token: 'worker-token',
      fetchImpl,
    }
    await syncRemoteSkillsOnce(options)
    expect(
      await readFile(
        join(configDir, 'skills', 'Wrapped-12345678', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# Wrapped\n')

    expectedDigest = '0'.repeat(64)
    await expect(syncRemoteSkillsOnce(options)).rejects.toThrow(
      'archive digest does not match manifest',
    )
    expect(
      await readFile(
        join(configDir, 'skills', 'Wrapped-12345678', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# Wrapped\n')
  })
})

describe('Tag session plugin sync', () => {
  test('ordinary Remote does not start plugin synchronization', async () => {
    const previous = process.env.CLAUDE_CODE_SYNC_PLUGINS
    delete process.env.CLAUDE_CODE_SYNC_PLUGINS
    try { await startRemotePluginSync() } finally {
      if (previous !== undefined) process.env.CLAUDE_CODE_SYNC_PLUGINS = previous
    }
  })

  test('keeps native plugin components together and removes only managed plugin roots', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'remote-plugins-'))
    temporaryDirectories.push(configDir)
    const archive = Buffer.from(zipSync({
      'engineering/.claude-plugin/plugin.json': strToU8('{"name":"engineering"}'),
      'engineering/skills/review/SKILL.md': strToU8('---\nname: review\ndescription: Review code\n---\nInspect the change.'),
      'engineering/commands/check.md': strToU8('Review this code.'),
      'engineering/hooks/hooks.json': strToU8('{"hooks":{}}'),
      'engineering/scripts/check.sh': [strToU8('#!/bin/sh\necho checked\n'), {os:3, attrs:(0o100755 << 16) >>> 0}],
      'engineering/settings.json': strToU8('{"agent":"reviewer"}'),
      'engineering/agents/reviewer.md': strToU8('---\nname: reviewer\ndescription: Code reviewer\n---\nReview code.'),
    }))
    const version = createHash('sha256').update(archive).digest('hex')
    let selected = true
    const paths: string[] = []
    const options = {
      configDir, apiBaseURL:'https://code.internal',sessionID:'session-tag',token:'worker-token',
      fetchImpl: (async (input: string | URL | Request) => {
        paths.push(String(input))
        return String(input).endsWith('skill-manifest')
          ? Response.json({skills:[],plugins:selected ? [{id:'plugin-1',name:'engineering',version,directory:'engineering'}] : []})
          : new Response(archive)
      }) as typeof fetch,
    }
    await mkdir(join(configDir,'skills','personal'),{recursive:true})
    await writeFile(join(configDir,'skills','personal','SKILL.md'),'untouched')
    const roots = await syncRemotePluginsOnce(options)
    expect(roots).toEqual([join(configDir,'plugins','synced','engineering')])
    for (const file of ['skills/review/SKILL.md','commands/check.md','hooks/hooks.json','settings.json','agents/reviewer.md']) {
      expect((await readFile(join(roots[0]!,file),'utf8')).length).toBeGreaterThan(0)
    }
    expect(paths[1]).toEndWith('/worker/plugins/plugin-1/download')
    expect((await stat(join(roots[0]!,'scripts','check.sh'))).mode & 0o100).toBe(0o100)
    // Exercise the existing component loader; no alternative commands/hooks parser.
    const {setSyncedPluginDirs} = await import('../../bootstrap/state.js')
    const {loadAllPluginsCacheOnly,clearPluginCache} = await import('../plugins/pluginLoader.js')
    setSyncedPluginDirs(roots)
    clearPluginCache()
    try {
      const loaded = await loadAllPluginsCacheOnly()
      const plugin = loaded.enabled.find(item => item.source === 'engineering@synced')
      expect(plugin?.name).toBe('engineering')
      expect(plugin?.path).toBe(roots[0])
      expect(plugin?.skillsPath).toBe(join(roots[0]!,'skills'))
      expect(plugin?.commandsPath).toBe(join(roots[0]!,'commands'))
      expect(plugin?.agentsPath).toBe(join(roots[0]!,'agents'))
    } finally { setSyncedPluginDirs([]); clearPluginCache() }
    selected = false
    expect(await syncRemotePluginsOnce(options)).toEqual([])
    expect(await readFile(join(configDir,'skills','personal','SKILL.md'),'utf8')).toBe('untouched')
    await expect(readFile(join(roots[0]!,'.claude-plugin','plugin.json'))).rejects.toThrow()
  })

  test('rejects a plugin archive with a mismatched digest', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'remote-plugins-invalid-'))
    temporaryDirectories.push(configDir)
    const archive = Buffer.from(zipSync({'.claude-plugin/plugin.json':strToU8('{"name":"test"}')}))
    await expect(syncRemotePluginsOnce({configDir,apiBaseURL:'https://code.internal',sessionID:'session-tag',token:'token',
      fetchImpl:(async (input:string|URL|Request) => String(input).endsWith('skill-manifest')
        ? Response.json({skills:[],plugins:[{id:'p',name:'test',directory:'test',version:'0'.repeat(64)}]}) : new Response(archive)) as typeof fetch,
    })).rejects.toThrow('digest')
  })

  test('does not follow a synced-root symlink outside the session', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'remote-plugins-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'remote-plugins-outside-'))
    temporaryDirectories.push(configDir, outside)
    await mkdir(join(configDir,'plugins'))
    await symlink(outside,join(configDir,'plugins','synced'))
    await expect(syncRemotePluginsOnce({configDir,apiBaseURL:'https://code.internal',sessionID:'session-tag',token:'token',
      fetchImpl:(async (_input: string | URL | Request): Promise<Response> => { throw new Error('must not fetch') }) as typeof fetch,
    })).rejects.toThrow('regular directory')
    await expect(stat(join(outside,'.staging'))).rejects.toThrow()
  })
})
