import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { loadPluginHooks } from '../../utils/plugins/loadPluginHooks.js'
import { loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'

type SetSDKAppState = (updater: (prev: AppState) => AppState) => void

/**
 * Initialize the plugin components required by an SDK turn without performing
 * an explicit marketplace refresh.
 *
 * Interactive OpenClaude uses the cache-only loader on startup and reserves
 * the full refresh path for /reload-plugins. SDK v2 previously called that
 * refresh before turn one, which could update every marketplace and parse MCP
 * and LSP components before the first model request. Local SDK plugin roots
 * are already materialized by the host; cache-only discovery plus hooks is the
 * correct startup contract. Commands, skills, agents and MCP configs consume
 * the same memoized cache through their native loaders.
 */
export async function initializeSDKLocalPlugins(
  setAppState: SetSDKAppState,
): Promise<void> {
  const { enabled, disabled, errors } = await loadAllPluginsCacheOnly()
  setAppState(prev => ({
    ...prev,
    plugins: {
      ...prev.plugins,
      enabled,
      disabled,
      errors,
      needsRefresh: false,
    },
  }))

  try {
    await loadPluginHooks()
  } catch (error) {
    logError(error)
    logForDebugging(
      `SDK: plugin hook loading failed: ${errorMessage(error)}`,
    )
  }
}
