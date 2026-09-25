import { parseDarbCatalog, type DarbDefaultModel } from './darbCatalog.js'

const origin = 'https://ai.darbmind.ru'
const tokenPrefix = 'darb-native-inference-v2.'
type HostRefresh = (signal: AbortSignal) => Promise<string | null>
type NativeContext = Readonly<{
  version: 2
  account_uuid: string
  organization_uuid: string
  native_surface: 'code' | 'cowork'
  defaultModel: string
  models: readonly DarbDefaultModel[]
}>

export function parseNativeGatewayContext(input: unknown): NativeContext {
  const v = input as Record<string, unknown> | null
  const identity = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(s)
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.version !== 2 ||
      !identity(v.account_uuid) || !identity(v.organization_uuid) || !['code', 'cowork'].includes(String(v.native_surface)) ||
      Object.keys(v).some(k => !['version', 'account_uuid', 'organization_uuid', 'native_surface', 'catalog'].includes(k))) {
    throw new Error('Invalid Darb native inference context')
  }
  const catalog = parseDarbCatalog(v.catalog)
  const defaultModel = (v.catalog as Record<string, unknown>).default_model
  if (catalog.mode !== 'default' || catalog.models.some(m => !m.max_context_tokens || !m.max_input_tokens || !m.max_output_tokens)) {
    throw new Error('Darb native inference requires the complete default model catalog')
  }
  if (typeof defaultModel !== 'string' || !catalog.models.some(m => m.id === defaultModel)) {
    throw new Error('Darb native default model is missing from the owner catalog')
  }
  return Object.freeze({version: 2, account_uuid: v.account_uuid, organization_uuid: v.organization_uuid,
    native_surface: v.native_surface as 'code' | 'cowork', defaultModel, models: catalog.models})
}

// Each SDK process has an account-bound catalog, rather than the single-model
// frozen context used by server workers. This permits native model changes and
// subagents without falling back to Claude family limits for Alibaba models.
export class NativeGatewaySession {
  private refresh: HostRefresh | undefined
  constructor(readonly context: NativeContext) {}

  setRefresh(refresh: HostRefresh): void { this.refresh = refresh }

  findModel(id: string): DarbDefaultModel | undefined {
    const canonical = /^(claude-[a-z0-9][a-z0-9._-]*)\[1m\]$/.exec(id)?.[1] ?? id
    return this.context.models.find(row => row.id === canonical)
  }

  model(id: string): DarbDefaultModel {
    const model = this.findModel(id)
    if (!model) throw new Error('The selected model is not in this Darb native session catalog')
    return model
  }

  fetch(fetcher: typeof fetch): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== origin || url.username || url.password ||
          !['/v1/messages', '/v1/messages/count_tokens', '/v1/models'].includes(url.pathname)) {
        throw new Error('Darb native inference destination changed')
      }
      if (request.method === 'POST') {
        const body = await request.clone().json() as {model?: unknown}
        if (typeof body.model !== 'string') throw new Error('Darb native inference model is missing')
        this.model(body.model)
      }
      if (!this.refresh) throw new Error('Darb native host credential refresh is unavailable')
      // The native SDK already implements this host-auth control protocol. Ask
      // the host before every wire attempt, including long-running Cowork tool
      // loops; never reuse a five-minute bearer as a session-long credential.
      const acquire = async () => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)])
        const token = await this.refresh!(signal)
        if (signal.aborted) throw new Error('Darb native credential refresh was cancelled')
        if (typeof token !== 'string' || !token.startsWith(tokenPrefix) || token.length <= tokenPrefix.length || token.length > 8192 || /\s|[\u0000-\u001f\u007f]/.test(token)) {
          throw new Error('Darb native host returned an invalid inference credential')
        }
        return token
      }
      const attempt = async () => {
        const token = await acquire()
        const headers = new Headers(request.headers)
        const names: string[] = []
        headers.forEach((_value, key) => names.push(key))
        for (const key of names) {
          if (/^(authorization|x-api-key|api-key|proxy-authorization)$/i.test(key) || /^x-(darb|sdk)-(connection|catalog|context)-/i.test(key) || /^x-internal-/i.test(key)) headers.delete(key)
        }
        headers.set('Authorization', `Bearer ${token}`)
        return fetcher(new Request(request.clone(), {headers, redirect: 'error'}))
      }
      const response = await attempt()
      if (response.status !== 401) return response
      await response.body?.cancel()
      // One bounded retry for a credential revoked/expired between exchange
      // and use. No provider fallback, stale bearer or silent model substitution.
      return attempt()
    }) as typeof fetch
  }
}

const bootstrap = process.env.DARB_NATIVE_INFERENCE_CONTEXT_JSON
export const nativeGatewaySession: NativeGatewaySession | undefined = (() => {
  if (bootstrap === undefined) return undefined
  if (process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST !== '1' ||
      process.env.ANTHROPIC_BASE_URL !== origin || process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL !== origin ||
      process.env.DARB_FROZEN_MODEL_CONTEXT_JSON !== undefined || Buffer.byteLength(bootstrap) > 2 * 1024 * 1024) {
    throw new Error('Darb native inference requires the canonical managed host')
  }
  return new NativeGatewaySession(parseNativeGatewayContext(JSON.parse(bootstrap)))
})()
