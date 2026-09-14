import axios from 'axios'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { darbCatalogSession, darbModelScope, isDarbManagedInference } from '../../utils/model/darbModels.js'

export class DarbCatalogUnavailable extends Error {}

export function darbCatalogErrorMessage(error: unknown): string {
  return error instanceof DarbCatalogUnavailable ? error.message : 'Darb model catalog could not be loaded. Run /model refresh to retry.'
}

// This is required account configuration, not optional telemetry/prefetch.
// No API-key helper, provider key, file cache or external URL is involved.
export async function refreshDarbModels(): Promise<void> {
  if (!isDarbManagedInference()) return
  const scope = darbModelScope()
  if (!scope) throw new DarbCatalogUnavailable('Sign in to Darb before selecting an AI connection')
  const generation = darbCatalogSession.begin(scope)
  let response
  try {
    response = await withOAuth401Retry(async () => {
    const token = getClaudeAIOAuthTokens()?.accessToken
    if (!token || darbModelScope() !== scope) throw new DarbCatalogUnavailable('Darb account changed; sign in again')
    return axios.get<unknown>('https://ai.darbmind.ru/v1/models?limit=1000', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': getClaudeCodeUserAgent() },
      timeout: 10000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024,
    })
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
