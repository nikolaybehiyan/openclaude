import { resolve } from 'node:path'
import { getInlinePlugins, setInlinePlugins } from '../../bootstrap/state.js'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import type { SdkPluginConfig } from './coreTypes.generated.js'

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJSON).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJSON(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Apply the official Agent SDK local-plugin option to OpenClaude's existing
 * native inline-plugin loader. The caller supplies already-materialized local
 * roots; OpenClaude owns discovery and registration of every plugin component.
 */
export function applySDKLocalPlugins(
  plugins: readonly SdkPluginConfig[] | undefined,
): { paths: string[]; changed: boolean } {
  if (plugins === undefined) {
    return { paths: [...getInlinePlugins()], changed: false }
  }

  const paths = [...new Set(plugins.map((plugin, index) => {
    if (!plugin || plugin.type !== 'local') {
      throw new Error(`plugins[${index}] must have type "local"`)
    }
    const pluginPath = plugin.path?.trim()
    if (!pluginPath) {
      throw new Error(`plugins[${index}].path must be non-empty`)
    }
    return resolve(pluginPath)
  }))].sort((left, right) => left.localeCompare(right))

  const current = [...new Set(getInlinePlugins().map(pluginPath =>
    resolve(pluginPath),
  ))].sort((left, right) => left.localeCompare(right))
  const changed = stableJSON(current) !== stableJSON(paths)
  if (changed) {
    setInlinePlugins(paths)
    clearAllCaches()
  }
  return { paths, changed }
}
