import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from '../../commands.js'
import {
  createSkillCommand,
  getSkillDirCommands,
  parseSkillFrontmatterFields,
} from '../../skills/loadSkillsDir.js'
import type { Command } from '../../types/command.js'
import type { LoadedPlugin, PluginManifest } from '../../types/plugin.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { getPluginCommands, getPluginSkills } from '../../utils/plugins/loadPluginCommands.js'
import { loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import {
  loadPluginOptions,
  substitutePluginVariables,
  substituteUserConfigInContent,
} from '../../utils/plugins/pluginOptionsStorage.js'
import type { HooksSettings } from '../../schemas/hooks.js'

export type SDKRuntimeCommandProjection = {
  name: string
  metadataMarkdown: string
  filePath?: string
  content?: string
  kind: 'skill' | 'command'
  source: 'standalone' | 'plugin'
  pluginName?: string
}

export type SDKRuntimePluginProjection = {
  name: string
  path: string
  source: string
  manifest: PluginManifest
  hooksConfig?: HooksSettings
}

export type SDKRuntimeExtensionsProjection = {
  commands: SDKRuntimeCommandProjection[]
  plugins: SDKRuntimePluginProjection[]
}

function nativeCommand(
  definition: SDKRuntimeCommandProjection,
  markdown: string,
  plugin?: SDKRuntimePluginProjection,
): Command {
  const expanded = plugin
    ? substitutePluginVariables(markdown, { path: plugin.path, source: plugin.source })
    : markdown
  const parsedMarkdown = parseFrontmatter(expanded, definition.filePath ?? definition.name)
  const content = plugin?.manifest.userConfig
    ? substituteUserConfigInContent(
        parsedMarkdown.content,
        loadPluginOptions(plugin.source),
        plugin.manifest.userConfig,
      )
    : parsedMarkdown.content
  const command = createSkillCommand({
    ...parseSkillFrontmatterFields(
      parsedMarkdown.frontmatter,
      content,
      definition.name,
      definition.kind === 'command' ? 'Custom command' : 'Skill',
    ),
    skillName: definition.name,
    markdownContent: content,
    source: plugin ? 'plugin' : 'project',
    baseDir: definition.kind === 'skill'
      ? dirname(definition.filePath ?? plugin!.path)
      : undefined,
    loadedFrom: plugin
      ? 'plugin'
      : definition.kind === 'command'
        ? 'commands_DEPRECATED'
        : 'skills',
    paths: undefined,
  })
  if (plugin && command.type === 'prompt') {
    command.pluginInfo = {
      pluginManifest: plugin.manifest,
      repository: plugin.source,
    }
  }
  return command
}

function lazyCommand(
  definition: SDKRuntimeCommandProjection,
  plugin?: SDKRuntimePluginProjection,
): Command {
  const metadata = nativeCommand(definition, definition.metadataMarkdown, plugin)
  if (metadata.type !== 'prompt') throw new Error(`${definition.name} is not prompt based`)
  let loaded: Command | undefined
  return {
    ...metadata,
    contentLength: 0,
    async getPromptForCommand(args, context) {
      loaded ??= nativeCommand(
        definition,
        definition.content ?? await readFile(definition.filePath!, 'utf8'),
        plugin,
      )
      if (loaded.type !== 'prompt') throw new Error(`${definition.name} is not prompt based`)
      return loaded.getPromptForCommand(args, context)
    },
  }
}

function loadedPlugin(plugin: SDKRuntimePluginProjection): LoadedPlugin {
  return {
    ...plugin,
    repository: plugin.source,
    enabled: true,
    hooksConfig: plugin.hooksConfig,
  }
}

/** Register the backend-owned snapshot in OpenClaude's native registries. */
export function installSDKRuntimeProjection(
  cwd: string,
  projection: SDKRuntimeExtensionsProjection,
): Command[] {
  const plugins = new Map(projection.plugins.map(plugin => [plugin.name, plugin]))
  const commands = projection.commands.map(definition =>
    lazyCommand(definition, definition.pluginName
      ? plugins.get(definition.pluginName)
      : undefined))
  const pluginCommands = commands.filter((_, index) =>
    projection.commands[index]?.source === 'plugin' && projection.commands[index]?.kind === 'command')
  const pluginSkills = commands.filter((_, index) =>
    projection.commands[index]?.source === 'plugin' && projection.commands[index]?.kind === 'skill')
  const standaloneCommands = commands.filter((_, index) =>
    projection.commands[index]?.source === 'standalone')
  const modelCommands = commands.filter(command =>
    !command.disableModelInvocation &&
    (command.loadedFrom !== 'plugin' || command.hasUserSpecifiedDescription || command.whenToUse))
  const slashSkills = commands.filter(command =>
    (command.hasUserSpecifiedDescription || command.whenToUse) &&
    (command.loadedFrom === 'skills' || command.loadedFrom === 'plugin' || command.disableModelInvocation))

  getPluginCommands.cache?.set(undefined, Promise.resolve(pluginCommands))
  getPluginSkills.cache?.set(undefined, Promise.resolve(pluginSkills))
  getSkillDirCommands.cache?.set(cwd, Promise.resolve(standaloneCommands))
  getSkillToolCommands.cache?.set(cwd, Promise.resolve(modelCommands))
  getSlashCommandToolSkills.cache?.set(cwd, Promise.resolve(slashSkills))
  loadAllPluginsCacheOnly.cache?.set(undefined, Promise.resolve({
    enabled: projection.plugins.map(loadedPlugin),
    disabled: [],
    errors: [],
  }))
  return commands
}
