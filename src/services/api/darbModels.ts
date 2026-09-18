import axios from 'axios'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { currentDarbCustomCatalog, darbCatalogSession, darbModelScope, isDarbManagedInference, requireDarbModelCandidate } from '../../utils/model/darbModels.js'
import { darbCatalogFromSelector } from '../../utils/model/darbCatalog.js'
import { parseDarbNativeThinking, validateDarbNativeThinking, type DarbNativeThinking } from '../../utils/model/darbModelControls.js'

export class DarbCatalogUnavailable extends Error {}

export function darbCatalogErrorMessage(error: unknown): string {
  return error instanceof DarbCatalogUnavailable ? error.message : 'Darb model catalog could not be loaded. Run /model refresh to retry.'
}

function identity(scope: string): { account: string; organization: string; path: string } {
  const parts: unknown = JSON.parse(scope)
  if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== 'https://ai.darbmind.ru' || parts.slice(1).some(value => typeof value !== 'string' || !value)) throw new DarbCatalogUnavailable('Darb account changed; sign in again')
  return { account: parts[1], organization: parts[2], path: `https://ai.darbmind.ru/api/organizations/${encodeURIComponent(parts[2])}` }
}

function requestOptions(scope: string) {
  const token = getClaudeAIOAuthTokens()?.accessToken
  if (!token || darbModelScope() !== scope) throw new DarbCatalogUnavailable('Darb account changed; sign in again')
  return { headers: { Authorization: `Bearer ${token}`, 'User-Agent': getClaudeCodeUserAgent() },
    timeout: 10000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024 }
}

// This is required account configuration, not optional telemetry/prefetch.
// No API-key helper, provider key, file cache or external URL is involved.
export async function refreshDarbModels(): Promise<void> {
  if (!isDarbManagedInference()) return
  const scope = darbModelScope()
  if (!scope) throw new DarbCatalogUnavailable('Sign in to Darb before selecting an AI connection')
  const generation = darbCatalogSession.begin(scope)
  const owner = identity(scope)
  let response
  try {
    response = await withOAuth401Retry(async () => {
    const selector = await axios.get<unknown>(`${owner.path}/model_selector/cli`, requestOptions(scope))
    if (darbModelScope() !== scope) throw new DarbCatalogUnavailable('Darb account changed; sign in again')
    const catalog = darbCatalogFromSelector(selector.data, owner.account, owner.organization) as { configuration_mode: string }
    if (catalog.configuration_mode === 'custom') return { data: catalog }
    const native = await axios.get<unknown>('https://ai.darbmind.ru/v1/models?limit=1000', requestOptions(scope))
    if ((native.data as { configuration_mode?: unknown })?.configuration_mode !== 'default') throw new DarbCatalogUnavailable('Darb connection or model selection changed; run /model refresh')
    return native
    })
  } catch (error) {
    if (error instanceof DarbCatalogUnavailable) throw error
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const message = status === 401 ? 'Darb sign-in expired. Run /login.'
      : status === 403 ? 'Your organization does not allow this CLI connection. Contact your administrator.'
      : status === 409 ? 'Your Darb connection or model selection changed. Review Customize → Connections, then run /model refresh.'
      : 'Darb model catalog could not be loaded. Run /model refresh to retry.'
    throw new DarbCatalogUnavailable(message)
  }
  if (darbModelScope() !== scope) throw new DarbCatalogUnavailable('Darb account changed; sign in again')
  try {
    if (!darbCatalogSession.complete(scope, generation, response.data)) {
      throw new Error('Darb model catalog was superseded; run /model refresh')
    }
  } catch (error) {
    // Parser errors are our own bounded messages, never a raw HTTP response.
    throw new DarbCatalogUnavailable(error instanceof Error ? error.message : 'Invalid Darb model catalog')
  }
}

// An explicit owner preference change. No cookies, provider keys, optimistic
// UI ACK, custom->default fallback, or blind retry after an ambiguous write.
export async function saveDarbModelSelection(model: string, thinking?: DarbNativeThinking | null): Promise<void> {
  const scope = darbModelScope(), catalog = currentDarbCustomCatalog(), binding = requireDarbModelCandidate(model)
  if (!scope || !catalog?.configuration_revision) throw new DarbCatalogUnavailable('Refresh the Darb selector before changing the selection')
  if (thinking !== undefined) validateDarbNativeThinking(binding, thinking)
  const owner = identity(scope)
  const generation = darbCatalogSession.begin(scope)
  try {
    const response = await withOAuth401Retry(() => axios.patch<Record<string, unknown>>(`${owner.path}/model_selector_state/cli`, {
      model, ...(thinking === undefined ? {} : { thinking }),
      configuration_revision: catalog.configuration_revision,
      account_uuid: owner.account, organization_uuid: owner.organization,
      connection_id: binding.connection_id, connection_revision: binding.connection_revision, catalog_revision: binding.catalog_revision,
    }, requestOptions(scope)))
    const state = response.data
    if (darbModelScope() !== scope || state.account_uuid !== owner.account || state.organization_uuid !== owner.organization ||
        state.configuration_mode !== 'custom' || state.configuration_revision !== catalog.configuration_revision || state.model !== model ||
        state.connection_id !== binding.connection_id || state.connection_revision !== binding.connection_revision || state.catalog_revision !== binding.catalog_revision ||
        thinking !== undefined && JSON.stringify(parseDarbNativeThinking(state.thinking)) !== JSON.stringify(parseDarbNativeThinking(thinking))) throw new Error('Darb selection changed while saving')
    if (!darbCatalogSession.complete(scope, generation, {
      configuration_mode: 'custom', configuration_revision: catalog.configuration_revision, status: 'ready', has_more: false,
      data: catalog.models.map(row => ({ ...row, capabilities: row })), saved_selection: state, native_selector_state: state,
    })) throw new Error('Darb selection was superseded')
  } catch {
    throw new DarbCatalogUnavailable('Darb selection could not be confirmed. Run /model refresh before retrying; the owner may already have saved it.')
  }
}
