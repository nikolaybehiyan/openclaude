import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from '../../commands.js'
import { installSDKRuntimeProjection } from './skills.js'

const roots: string[] = []

afterAll(async () => {
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

describe('SDK authoritative skill runtime', () => {
  test('installs native listings and reads only the invoked exact file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openclaude-sdk-skills-'))
    roots.push(root)
    const skillRoot = join(root, 'direct')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      '---\nname: direct\ndescription: Disk content\n---\n\nDo the exact task.\n',
    )
    const definitions = [{
      name: 'direct',
      metadataMarkdown: '---\nname: direct\ndescription: DB description\nallowed-tools: Read\nmodel: haiku\ncontext: fork\nagent: general-purpose\neffort: low\n---\n',
      filePath: join(skillRoot, 'SKILL.md'),
      kind: 'skill' as const,
      source: 'standalone' as const,
    }]

    const commands = installSDKRuntimeProjection(root, {
      commands: definitions,
      plugins: [],
    })
    expect((await getSkillToolCommands(root)).map(command => command.name)).toEqual(['direct'])
    expect((await getSlashCommandToolSkills(root)).map(command => command.name)).toEqual(['direct'])
    expect(commands[0]?.description).toBe('DB description')
    expect(commands[0]?.allowedTools).toEqual(['Read'])
    expect(commands[0]?.model).toBeDefined()
    expect(commands[0]?.context).toBe('fork')
    expect(commands[0]?.agent).toBe('general-purpose')
    expect(commands[0]?.effort).toBe('low')
    const prompt = commands[0]?.type === 'prompt'
      ? await commands[0].getPromptForCommand('', {} as never)
      : []
    expect(JSON.stringify(prompt)).toContain('Do the exact task.')
  })

})
