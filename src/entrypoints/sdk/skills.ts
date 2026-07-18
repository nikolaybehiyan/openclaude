import { isAbsolute } from 'node:path'
import {
  addSkillDirectories,
  clearDynamicSkills,
  getDynamicSkills,
  onDynamicSkillsLoaded,
} from '../../skills/loadSkillsDir.js'
import { clearCommandMemoizationCaches } from '../../commands.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { resetSentSkillNames } from '../../utils/attachments.js'

export type SDKSkillRuntimeIntent = {
  revision?: string
  skillDirectories?: string[]
  enabledSkillNames?: string[]
}

export type SDKSkillPreparationResult = {
  changed: boolean
  revision?: string
  discoveredSkillCount: number
  enabledSkillCount: number
  enabledSkillNames: string[]
}

let currentIntentFingerprint = ''
let enabledSkillNames = new Set<string>()
let listenerInstalled = false

function applyAllowlist(): void {
  for (const skill of getDynamicSkills()) {
    const name = skill.name
    skill.isEnabled = () => enabledSkillNames.has(name)
  }
}

function refreshSkillPresentation(): void {
  applyAllowlist()
  clearCommandMemoizationCaches()
  resetSentSkillNames()
}

function ensureListener(): void {
  if (listenerInstalled) return
  onDynamicSkillsLoaded(() => {
    refreshSkillPresentation()
  })
  listenerInstalled = true
}

export async function unstable_prepareSkillRuntime(
  intent: SDKSkillRuntimeIntent = {},
): Promise<SDKSkillPreparationResult> {
  const revision = intent.revision?.trim()
  const skillDirectories = [
    ...new Set((intent.skillDirectories ?? []).map(value => value.trim())),
  ]
  const names = [
    ...new Set((intent.enabledSkillNames ?? []).map(value => value.trim())),
  ].sort()
  if (
    (intent.revision !== undefined && !revision) ||
    skillDirectories.some(value => !value || !isAbsolute(value)) ||
    names.some(value => !value || value.includes('/') || value.includes('\\'))
  ) {
    throw new Error('invalid standalone skill runtime intent')
  }
  const fingerprint = JSON.stringify([revision, skillDirectories, names])
  const changed = fingerprint !== currentIntentFingerprint

  ensureListener()
  enabledSkillNames = new Set(names)

  if (changed) {
    if (
      skillDirectories.length > 0 &&
      !isSettingSourceEnabled('projectSettings')
    ) {
      throw new Error(
        'skill runtime requires SDK settingSources to include "project"',
      )
    }
    clearDynamicSkills()
    await addSkillDirectories(skillDirectories)
    refreshSkillPresentation()
    currentIntentFingerprint = fingerprint
  } else {
    applyAllowlist()
  }

  const discoveredSkills = getDynamicSkills()
  return {
    changed,
    revision,
    discoveredSkillCount: discoveredSkills.length,
    enabledSkillCount: discoveredSkills.filter(skill =>
      enabledSkillNames.has(skill.name),
    ).length,
    enabledSkillNames: names,
  }
}
