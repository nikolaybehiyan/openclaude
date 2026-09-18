import { CONNECT_AI, darbCatalogSession } from './darbCatalog.js'
import { getDarbFrozenModelContext } from './darbFrozenContext.js'
import { getGlobalConfig } from '../config.js'
import { getAPIProvider } from './providers.js'
import { darbCanSelectThinking, validateDarbNativeThinking, type DarbThinkingType } from './darbModelControls.js'
import { readDarbSessionThinking } from './darbSessionBinding.js'

export { darbCatalogSession }

// Use the existing Darb launcher identity. A Desktop external inference
// bridge or an explicit third-party profile must not receive Darb OAuth.
export function isDarbManagedInference(): boolean {
  return getAPIProvider() === 'firstParty' &&
    process.env.DARB_CLI_MANAGED_INFERENCE === '1' &&
    !process.env.CLAUDE_CODE_REMOTE_SESSION_ID &&
    !process.env.CLAUDE_AGENT_SDK_CLIENT_APP &&
    !getDarbFrozenModelContext() &&
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === '1' &&
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL?.replace(/\/$/, '') === 'https://ai.darbmind.ru' &&
    process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, '') === 'https://ai.darbmind.ru'
}

export function darbModelScope(): string | undefined {
  if (!isDarbManagedInference()) return undefined
  const account = getGlobalConfig().oauthAccount
  if (!account?.accountUuid || !account.organizationUuid) return undefined
  return JSON.stringify(['https://ai.darbmind.ru', account.accountUuid, account.organizationUuid])
}

export function currentDarbCatalog() {
  // Tool schemas can be evaluated while config.ts is still initializing.
  // No cached owner result means fail closed without touching account state.
  if (!darbCatalogSession.hasCatalog()) return undefined
  return darbCatalogSession.current(darbModelScope())
}

// Unknown/unloaded state stays on the fail-closed custom branch. Only an
// authenticated explicit-default response restores native model behavior.
// Keep identity/refresh/transport guards on isDarbManagedInference instead.
export function isDarbCustomInference(): boolean {
  return isDarbManagedInference() && currentDarbCatalog()?.mode !== 'default'
}

export function currentDarbCustomCatalog() {
  const catalog = currentDarbCatalog()
  return catalog?.mode === 'custom' ? catalog : undefined
}

export function darbDefaultModel(): string {
  // Empty means no selection, never a wire model or an alias.
  return currentDarbCustomCatalog()?.defaultModel ?? ''
}

export function darbModelLabel(model?: string | null): string {
  const id = model || darbDefaultModel()
  const binding = currentDarbCustomCatalog()?.models.find(row => row.id === id)
  return binding ? (binding.display_name === id ? id : `${binding.display_name} (${id})`) : id || 'Connect AI'
}

export function requireDarbModel(model: string | undefined) {
  const binding = currentDarbCustomCatalog()?.models.find(row => row.id === model)
  if (!binding) throw new Error(CONNECT_AI)
  return binding
}

export function darbModelOptions() {
  return currentDarbCustomCatalog()?.models.map(model => ({
    value: model.id, label: darbModelLabel(model.id), description: model.id,
  })) ?? []
}

export function darbModelReasoning(model: string): boolean {
  return darbModelThinking(model, 'enabled') || darbModelThinking(model, 'adaptive')
}

export function darbModelThinking(model: string, type: DarbThinkingType): boolean {
  const row = currentDarbCustomCatalog()?.models.find(row => row.id === model)
  return row !== undefined && darbCanSelectThinking(row, type)
}

export function darbSelectedThinking(model: string) {
  const row = currentDarbCustomCatalog()?.models.find(row => row.id === model)
  if (!row) return undefined
  const scope = darbModelScope()
  const local = scope ? readDarbSessionThinking(scope, row) : undefined
  const selected = local !== undefined ? local : row.selected_thinking
  if (selected !== undefined) validateDarbNativeThinking(row, selected)
  return selected
}

// Rendering is not an authorization boundary. A save deliberately revokes
// the catalog while awaiting the owner response; readers must tolerate that
// state without retaining a stale binding or throwing out of React render.
export function darbModelControlState(model: string) {
  const row = currentDarbCustomCatalog()?.models.find(row => row.id === model)
  if (!row) return { row: undefined, selected: undefined, error: CONNECT_AI }
  try { return { row, selected: darbSelectedThinking(model), error: undefined } }
  catch { return { row, selected: undefined, error: 'Saved controls are unavailable. Reset them explicitly or run /model refresh.' } }
}
