import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { syncRemoteSkillsOnce } from './remoteSkillSync.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path =>
      rm(path, { recursive: true, force: true }),
    ),
  )
})

describe('Remote account skill sync', () => {
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
