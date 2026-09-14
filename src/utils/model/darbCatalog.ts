import type { ClientOptions } from '@anthropic-ai/sdk'

type DarbFetch = NonNullable<ClientOptions['fetch']>

// Public catalog metadata only. Credentials, endpoints and provider routing
// remain owned by Darb. A model ID is opaque, including case and suffixes.
export type DarbModelBinding = Readonly<{
  id: string
  display_name: string
  connection_id: string
  connection_revision: number
  catalog_revision: string
  reasoning: boolean
  reasoning_efforts: readonly string[]
}>

export type DarbCatalog = Readonly<{
  models: readonly DarbModelBinding[]
  defaultModel: string
}>

export const CONNECT_AI = 'Connect AI in Darb → Customize → Connections, select a CLI model, then run /model refresh.'

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Darb model catalog')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

export function parseDarbCatalog(payload: unknown): DarbCatalog {
  const root = object(payload)
  if (!Array.isArray(root.data) || root.data.length > 1000 || root.has_more !== false) {
    throw new Error('Darb model catalog is incomplete; no model was selected')
  }
  // Old alias catalogs are not a connection and must never become a fallback.
  if (root.saved_selection == null) throw new Error(CONNECT_AI)
  const selected = object(root.saved_selection)
  const models = root.data.map(raw => {
    const row = object(raw)
    if (!text(row.id, 512) || !text(row.display_name, 512) ||
        typeof row.connection_id !== 'string' || !/^icn_[a-f0-9]{32}$/.test(row.connection_id) ||
        !Number.isSafeInteger(row.connection_revision) || Number(row.connection_revision) < 1 ||
        typeof row.catalog_revision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row.catalog_revision)) {
      throw new Error('Invalid Darb model binding')
    }
    const capabilities = row.capabilities == null ? {} : object(row.capabilities)
    const efforts = capabilities.reasoning_efforts ?? []
    if (!Array.isArray(efforts) || efforts.length > 16 || efforts.some(value => !text(value, 40)) ||
        new Set(efforts).size !== efforts.length ||
        (efforts.length > 0 && capabilities.reasoning !== true)) {
      throw new Error('Invalid Darb reasoning capabilities')
    }
    return Object.freeze({
      id: row.id, display_name: row.display_name,
      connection_id: row.connection_id, connection_revision: row.connection_revision as number,
      catalog_revision: row.catalog_revision,
      reasoning: capabilities.reasoning === true,
      reasoning_efforts: Object.freeze([...efforts]) as readonly string[],
    })
  })
  const ids = new Set(models.map(model => model.id))
  const defaultModel = models.find(model => model.id === selected.model &&
    model.connection_id === selected.connection_id &&
    model.connection_revision === selected.connection_revision &&
    model.catalog_revision === selected.catalog_revision)
  if (!defaultModel || ids.size !== models.length || models.some(model =>
    model.connection_id !== defaultModel.connection_id ||
    model.connection_revision !== defaultModel.connection_revision)) {
    throw new Error('Darb model selection changed; run /model refresh')
  }
  return Object.freeze({ models: Object.freeze(models), defaultModel: defaultModel.id })
}

// Deliberately memory-only. Each process obtains an authenticated catalog;
// disk caches from another account/provider never authorize a request.
export class DarbCatalogSession {
  private scope: string | undefined
  private catalog: DarbCatalog | undefined
  private generation = 0

  current(scope: string | undefined): DarbCatalog | undefined {
    return scope && this.scope === scope ? this.catalog : undefined
  }

  begin(scope: string): number {
    this.scope = scope
    this.catalog = undefined
    return ++this.generation
  }

  complete(scope: string, generation: number, payload: unknown): boolean {
    if (scope !== this.scope || generation !== this.generation) return false
    this.catalog = parseDarbCatalog(payload)
    return true
  }
}

export function darbBindingHeaders(binding: DarbModelBinding): Record<string, string> {
  return {
    'x-darb-connection-id': binding.connection_id,
    'x-darb-connection-revision': String(binding.connection_revision),
    'x-darb-catalog-revision': binding.catalog_revision,
  }
}

export function guardDarbFetch(
  fetcher: DarbFetch,
  origin: string,
  binding: DarbModelBinding,
  isCurrentAccount: () => boolean,
): DarbFetch {
  return async (input, init) => {
    if (!isCurrentAccount()) throw new Error('Darb account changed; run /login and /model refresh')
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== origin || url.username || url.password) {
      throw new Error('Darb inference destination changed')
    }
    if (request.method === 'POST' && /^\/v1\/messages(?:\/count_tokens)?$/.test(url.pathname)) {
      const body = await request.clone().json() as { model?: unknown }
      if (body.model !== binding.id) throw new Error('Darb model changed after request binding')
    }
    // Strip both public and internal binding headers supplied through custom
    // headers; only this frozen authenticated catalog may supply the binding.
    const headers = new Headers(request.headers)
    const names: string[] = []
    headers.forEach((_value, name) => names.push(name))
    for (const name of names) {
      if (/^x-(darb|sdk)-(connection|catalog)-/i.test(name)) headers.delete(name)
    }
    for (const [name, value] of Object.entries(darbBindingHeaders(binding))) headers.set(name, value)
    return fetcher(new Request(request, { headers, redirect: 'error' }))
  }
}
