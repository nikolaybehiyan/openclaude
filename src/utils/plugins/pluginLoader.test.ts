import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setInlinePlugins } from '../../bootstrap/state.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import {
  clearPluginSkillsCache,
  getPluginSkills,
} from './loadPluginCommands.js'
import { clearPluginCache, mergePluginSources } from './pluginLoader.js'

const tempPluginDirs: string[] = []

afterEach(() => {
  setInlinePlugins([])
  clearPluginCache('pluginLoader.test cleanup')
  clearPluginSkillsCache()
  for (const dir of tempPluginDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempPluginDirs.length = 0
})

function marketplacePlugin(
  name: string,
  marketplace: string,
  enabled: boolean,
): LoadedPlugin {
  const pluginId = `${name}@${marketplace}`
  return {
    name,
    manifest: { name } as LoadedPlugin['manifest'],
    path: `/tmp/${pluginId}`,
    source: pluginId,
    repository: pluginId,
    enabled,
  }
}

describe('mergePluginSources', () => {
  test('keeps the enabled copy when duplicate marketplace plugins disagree on enabled state', () => {
    const enabledOfficial = marketplacePlugin(
      'frontend-design',
      'claude-plugins-official',
      true,
    )
    const disabledLegacy = marketplacePlugin(
      'frontend-design',
      'claude-code-plugins',
      false,
    )

    const result = mergePluginSources({
      session: [],
      marketplace: [disabledLegacy, enabledOfficial],
      builtin: [],
    })

    expect(result.plugins).toEqual([enabledOfficial])
    expect(result.errors).toEqual([])
  })

  test('keeps the later copy when duplicate marketplace plugins are both enabled', () => {
    const legacy = marketplacePlugin(
      'frontend-design',
      'claude-code-plugins',
      true,
    )
    const official = marketplacePlugin(
      'frontend-design',
      'claude-plugins-official',
      true,
    )

    const result = mergePluginSources({
      session: [],
      marketplace: [legacy, official],
      builtin: [],
    })

    expect(result.plugins).toEqual([official])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({
      type: 'generic-error',
      source: legacy.source,
      plugin: legacy.name,
    })
  })
})

describe('plugin skill runtime metadata', () => {
  test('preserves fork agent and hooks from SKILL.md', async () => {
    const pluginDir = mkdtempSync(join(tmpdir(), 'openclaude-plugin-skill-'))
    tempPluginDirs.push(pluginDir)
    const manifestDir = join(pluginDir, '.claude-plugin')
    const skillDir = join(pluginDir, 'skills', 'investigate-deploy')
    mkdirSync(manifestDir, { recursive: true })
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(manifestDir, 'plugin.json'),
      JSON.stringify({ name: 'runtime-metadata-fixture', version: '1.0.0' }),
    )
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
description: Verify plugin runtime metadata
context: fork
agent: runtime-metadata-fixture:deploy-investigator
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: echo checked
---
Verify metadata.
`,
    )

    setInlinePlugins([pluginDir])
    clearPluginCache('pluginLoader.test fixture')
    clearPluginSkillsCache()
    const skills = await getPluginSkills()
    const skill = skills.find(
      item => item.name === 'runtime-metadata-fixture:investigate-deploy',
    )

    if (skill?.type !== 'prompt') {
      throw new Error(
        `plugin skill was not loaded; available: ${skills.map(item => item.name).join(', ')}`,
      )
    }
    expect(skill.context).toBe('fork')
    expect(skill.agent).toBe(
      'runtime-metadata-fixture:deploy-investigator',
    )
    expect(skill.skillRoot).toBe(pluginDir)
    expect(skill.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash')
  })
})
