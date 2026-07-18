import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setAllowedSettingSources } from '../../bootstrap/state.js'
import {
  clearDynamicSkills,
  getDynamicSkills,
} from '../../skills/loadSkillsDir.js'
import { isCommandEnabled } from '../../types/command.js'
import { unstable_prepareSkillRuntime } from './skills.js'

const roots: string[] = []

async function writeSkill(
  groupRoot: string,
  name: string,
  description: string,
): Promise<void> {
  const skillRoot = join(groupRoot, name)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  )
}

afterAll(async () => {
  clearDynamicSkills()
  setAllowedSettingSources(['userSettings'])
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

describe('SDK standalone skill runtime', () => {
  test('uses native discovery with an exact host allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openclaude-sdk-skills-'))
    roots.push(root)
    const publicRoot = join(root, 'public')
    const examplesRoot = join(root, 'examples')
    await writeSkill(publicRoot, 'docx', 'Create Word documents')
    await writeSkill(examplesRoot, 'skill-creator', 'Create skills')
    await writeSkill(examplesRoot, 'theme-factory', 'Create themes')
    setAllowedSettingSources(['userSettings', 'projectSettings'])

    const result = await unstable_prepareSkillRuntime({
      revision: 'revision-1',
      skillDirectories: [publicRoot, examplesRoot],
      enabledSkillNames: ['docx', 'skill-creator'],
    })

    expect(result).toEqual({
      changed: true,
      revision: 'revision-1',
      discoveredSkillCount: 3,
      enabledSkillCount: 2,
      enabledSkillNames: ['docx', 'skill-creator'],
    })
    const skills = new Map(getDynamicSkills().map(skill => [skill.name, skill]))
    expect(isCommandEnabled(skills.get('docx'))).toBe(true)
    expect(isCommandEnabled(skills.get('skill-creator'))).toBe(true)
    expect(isCommandEnabled(skills.get('theme-factory'))).toBe(false)
    expect(
      skills.get('docx')?.type === 'prompt'
        ? skills.get('docx')?.skillRoot
        : undefined,
    ).toBe(join(publicRoot, 'docx'))
  })

  test('reloads unchanged names when the host content revision changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openclaude-sdk-skills-'))
    roots.push(root)
    const userRoot = join(root, 'user')
    await writeSkill(userRoot, 'custom-skill', 'Version one')
    setAllowedSettingSources(['userSettings', 'projectSettings'])

    const first = await unstable_prepareSkillRuntime({
      revision: 'revision-2',
      skillDirectories: [userRoot],
      enabledSkillNames: ['custom-skill'],
    })
    const unchanged = await unstable_prepareSkillRuntime({
      revision: 'revision-2',
      skillDirectories: [userRoot],
      enabledSkillNames: ['custom-skill'],
    })
    const reloaded = await unstable_prepareSkillRuntime({
      revision: 'revision-3',
      skillDirectories: [userRoot],
      enabledSkillNames: ['custom-skill'],
    })

    expect(first.changed).toBe(true)
    expect(unchanged.changed).toBe(false)
    expect(reloaded.changed).toBe(true)
  })
})
