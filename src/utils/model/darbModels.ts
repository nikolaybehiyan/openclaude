import { getGlobalConfig } from '../config.js'
import { getAPIProvider } from './providers.js'
import { CONNECT_AI, DarbCatalogSession } from './darbCatalog.js'

export const darbCatalogSession = new DarbCatalogSession()

// Use the existing Darb launcher identity. A Desktop external inference
// bridge or an explicit third-party profile must not receive Darb OAuth.
export function isDarbManagedInference(): boolean {
  return getAPIProvider() === 'firstParty' &&
    process.env.DARB_CLI_MANAGED_INFERENCE === '1' &&
    !process.env.CLAUDE_CODE_REMOTE_SESSION_ID &&
    !process.env.CLAUDE_AGENT_SDK_CLIENT_APP &&
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
  return darbCatalogSession.current(darbModelScope())
}

export function darbDefaultModel(): string {
  // Empty means no selection, never a wire model or an alias.
  return currentDarbCatalog()?.defaultModel ?? ''
}

export function darbModelLabel(model?: string | null): string {
  const id = model || darbDefaultModel()
  const binding = currentDarbCatalog()?.models.find(row => row.id === id)
  return binding ? (binding.display_name === id ? id : `${binding.display_name} (${id})`) : id || 'Connect AI'
}

export function requireDarbModel(model: string | undefined) {
  const binding = currentDarbCatalog()?.models.find(row => row.id === model)
  if (!binding) throw new Error(CONNECT_AI)
  return binding
}

export function darbModelOptions() {
  return currentDarbCatalog()?.models.map(model => ({
    value: model.id, label: darbModelLabel(model.id), description: model.id,
  })) ?? []
}

export function darbModelReasoning(model: string): boolean {
  return currentDarbCatalog()?.models.find(row => row.id === model)?.reasoning === true
}
