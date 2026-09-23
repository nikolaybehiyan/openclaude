import type { ClientOptions } from '@anthropic-ai/sdk'
import { parseDarbNativeParameters, type DarbNativeParameters } from './darbFrozenContext.js'
import { parseDarbModelControls, parseDarbNativeThinking, parseDarbThinkingOptions, validateDarbNativeThinking, type DarbModelControls, type DarbNativeThinking } from './darbModelControls.js'

type DarbFetch = NonNullable<ClientOptions['fetch']>

// Public catalog metadata only. Credentials, endpoints and provider routing
// remain owned by Darb. A model ID is opaque, including case and suffixes.
export type DarbModelBinding = DarbModelControls & Readonly<{
  id: string
  display_name: string
  connection_id: string
  connection_revision: number
  catalog_revision: string
  reasoning: boolean
  // Presence is significant: absent owner state is unknown; null is reset.
  selected_thinking?: DarbNativeThinking | null
  supports_1m: boolean
  context_window_tokens: 0 | 1000000
  max_context_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
}>

export type DarbDefaultModel = Readonly<{
  id: string; display_name: string; type: 'model'; created_at?: string
  max_context_tokens?: number; max_input_tokens?: number; max_output_tokens?: number
  native_parameters?: DarbNativeParameters
}>

export type DarbCatalog = Readonly<{
  mode: 'custom'
  models: readonly DarbModelBinding[]
  defaultModel: string
  configuration_revision?: number
  selectionRequired?: true
}> | Readonly<{
  mode: 'default'
  models: readonly DarbDefaultModel[]
  // The default comes from the existing native account/model policy, not the
  // first row of an owner catalog. No synthetic gateway binding is created.
  defaultModel?: never
}>

export const CONNECT_AI = 'Connect AI in Darb → Customize → Connections, select a CLI model, then run /model refresh.'
export const CONFIRM_MODEL = 'Darb model configuration changed. Run /model and select the model again to confirm its current settings.'

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
  if (root.status !== undefined && root.status !== 'ready' && root.status !== 'selection_required') throw new Error(CONNECT_AI)
  if (root.configuration_mode === 'default') {
    if (root.status === 'selection_required') throw new Error('Invalid Darb default model catalog')
    if (root.saved_selection != null || root.data.length === 0) throw new Error('Invalid Darb default model catalog')
    const models = root.data.map(raw => {
      const row = object(raw)
      if (!text(row.id, 512) || !text(row.display_name, 512) || row.type !== 'model' ||
          row.connection_id !== undefined || row.connection_revision !== undefined || row.catalog_revision !== undefined ||
          row.context_window_tokens !== undefined ||
          (row.created_at !== undefined && !text(row.created_at, 128))) {
        throw new Error('Invalid Darb default model catalog')
      }
      const capacity = ['max_context_tokens', 'max_input_tokens', 'max_output_tokens'] as const
      const hasCapacity = capacity.some(key => row[key] !== undefined)
      if (hasCapacity && (capacity.some(key => !Number.isSafeInteger(row[key]) || Number(row[key]) <= 0) ||
          Number(row.max_input_tokens) > Number(row.max_context_tokens) || Number(row.max_output_tokens) > Number(row.max_context_tokens))) {
        throw new Error('Invalid Darb default model capacity')
      }
      const native = parseDarbNativeParameters(row.native_parameters)
      if (native && !hasCapacity) throw new Error('Invalid Darb default model capacity')
      return Object.freeze({ id: row.id, display_name: row.display_name, type: 'model' as const,
        ...(hasCapacity ? {max_context_tokens: row.max_context_tokens as number, max_input_tokens: row.max_input_tokens as number, max_output_tokens: row.max_output_tokens as number} : {}),
        ...(native ? {native_parameters: native} : {}),
        ...(row.created_at !== undefined ? { created_at: row.created_at as string } : {}) })
    })
    if (new Set(models.map(row => row.id)).size !== models.length) throw new Error('Invalid Darb default model catalog')
    return Object.freeze({ mode: 'default', models: Object.freeze(models) })
  }
  if (root.configuration_mode !== 'custom') throw new Error(CONNECT_AI)
  // Old alias catalogs are not a connection and must never become a fallback.
  if (root.saved_selection == null) throw new Error(CONNECT_AI)
  const selected = object(root.saved_selection)
  const nativeState = root.native_selector_state === undefined ? undefined : object(root.native_selector_state)
  if (nativeState?.model !== undefined && nativeState.model !== selected.model) throw new Error('Darb model selection changed; run /model refresh')
  const thinkingByModel = new Map<string, DarbNativeThinking | null>()
  if (nativeState?.thinking_by_model !== undefined) {
    if (!Array.isArray(nativeState.thinking_by_model) || nativeState.thinking_by_model.length > 1000) throw new Error('Invalid Darb model controls state')
    for (const item of nativeState.thinking_by_model) {
      const entry = object(item)
      if (!text(entry.id, 512) || thinkingByModel.has(entry.id)) throw new Error('Invalid Darb model controls state')
      thinkingByModel.set(entry.id, parseDarbNativeThinking(entry.thinking))
    }
  }
  if (nativeState && Object.hasOwn(nativeState, 'thinking')) {
    const thinking = parseDarbNativeThinking(nativeState.thinking)
    if (typeof selected.model !== 'string' || thinkingByModel.has(selected.model) && JSON.stringify(thinkingByModel.get(selected.model)) !== JSON.stringify(thinking)) throw new Error('Invalid Darb model controls state')
    thinkingByModel.set(selected.model, thinking)
  }
  if (selected.context_window_tokens != null && selected.context_window_tokens !== 0 && selected.context_window_tokens !== 1000000) {
    throw new Error('Invalid Darb context selection')
  }
  const models = root.data.map(raw => {
    const row = object(raw)
    if (!text(row.id, 512) || !text(row.display_name, 512) ||
        typeof row.connection_id !== 'string' || !/^icn_[a-f0-9]{32}$/.test(row.connection_id) ||
        !Number.isSafeInteger(row.connection_revision) || Number(row.connection_revision) < 1 ||
        typeof row.catalog_revision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row.catalog_revision)) {
      throw new Error('Invalid Darb model binding')
    }
    const facts = parseDarbModelControls(row.capabilities)
    const thinking = parseDarbThinkingOptions(row.thinking, facts)
    const controls = { ...facts, ...(thinking !== undefined ? { thinking } : {}) }
    const selectedThinking = thinkingByModel.get(row.id)
    if (thinkingByModel.has(row.id)) validateDarbNativeThinking(controls, selectedThinking!)
    const context = row.id === selected.model && selected.context_window_tokens != null
      ? selected.context_window_tokens : row.context_window_tokens ?? 0
    if ((row.supports_1m != null && typeof row.supports_1m !== 'boolean') ||
        (row.max_context_tokens !== undefined && (!Number.isSafeInteger(row.max_context_tokens) || Number(row.max_context_tokens) <= 0)) ||
        (row.max_input_tokens !== undefined && (!Number.isSafeInteger(row.max_input_tokens) || Number(row.max_input_tokens) <= 0)) ||
        (row.max_output_tokens !== undefined && (!Number.isSafeInteger(row.max_output_tokens) || Number(row.max_output_tokens) <= 0)) ||
        (context !== 0 && context !== 1000000) || (context === 1000000 && (row.supports_1m !== true || row.max_input_tokens !== undefined && Number(row.max_input_tokens) < 1000000 || row.max_context_tokens !== undefined && Number(row.max_context_tokens) < 1000000))) {
      throw new Error('Invalid Darb context capability')
    }
    return Object.freeze({
      id: row.id, display_name: row.display_name,
      connection_id: row.connection_id, connection_revision: row.connection_revision as number,
      catalog_revision: row.catalog_revision,
      ...controls,
      reasoning: controls.reasoning_support === 'supported',
      ...(thinkingByModel.has(row.id) ? { selected_thinking: selectedThinking! } : {}),
      supports_1m: row.supports_1m === true,
      context_window_tokens: context as 0 | 1000000,
      ...(row.max_context_tokens !== undefined ? { max_context_tokens: row.max_context_tokens as number } : {}),
      ...(row.max_input_tokens !== undefined ? { max_input_tokens: row.max_input_tokens as number } : {}),
      ...(row.max_output_tokens !== undefined ? { max_output_tokens: row.max_output_tokens as number } : {}),
    })
  })
  const ids = new Set(models.map(model => model.id))
  if ([...thinkingByModel.keys()].some(id => !ids.has(id))) throw new Error('Darb model controls state changed; run /model refresh')
  const defaultModel = models.find(model => model.id === selected.model &&
    model.connection_id === selected.connection_id &&
    model.connection_revision === selected.connection_revision &&
    model.catalog_revision === selected.catalog_revision)
  if (!defaultModel || ids.size !== models.length || models.some(model =>
    model.connection_id !== defaultModel.connection_id ||
    model.connection_revision !== defaultModel.connection_revision)) {
    throw new Error('Darb model selection changed; run /model refresh')
  }
  if (root.configuration_revision !== undefined && (!Number.isSafeInteger(root.configuration_revision) || Number(root.configuration_revision) < 1)) throw new Error('Invalid Darb configuration revision')
  return Object.freeze({ mode: 'custom', models: Object.freeze(models), defaultModel: defaultModel.id,
    ...(root.status === 'selection_required' ? { selectionRequired: true as const } : {}),
    ...(root.configuration_revision === undefined ? {} : { configuration_revision: root.configuration_revision as number }) })
}

// Authenticated owner selector envelope. The older /v1/models projection is
// still parsed separately for native default mode, never as a custom fallback.
export function darbCatalogFromSelector(payload: unknown, account: string, organization: string): unknown {
  const root = object(payload)
  if (root.account_uuid !== account || root.organization_uuid !== organization || !Number.isSafeInteger(root.configuration_revision) || Number(root.configuration_revision) < 0) throw new Error('Darb selector account or configuration changed')
  if (root.configuration_mode === 'default') return { configuration_mode: 'default' }
  if (Number(root.configuration_revision) < 1) throw new Error('Invalid Darb configuration revision')
  if (root.configuration_mode !== 'custom' || !['ready','selection_required'].includes(String(root.status)) || !Array.isArray(root.model_selector_config) || !Array.isArray(root.model_selector_state)) throw new Error(CONNECT_AI)
  const config = root.model_selector_config.map(object).filter(row => row.id === 'cli')
  const state = root.model_selector_state.map(object).filter(row => row.id === 'cli')
  if (config.length !== 1 || state.length !== 1 || !Array.isArray(config[0]!.models)) throw new Error('Invalid Darb CLI selector')
  const connection = object(config[0]!.inference_connection)
  if (connection.mode !== 'custom' || connection.status !== root.status || connection.configuration_revision !== root.configuration_revision) throw new Error('Darb selector configuration changed')
  return { configuration_mode: 'custom', status: root.status, configuration_revision: root.configuration_revision,
    data: config[0]!.models.map(raw => { const row = object(raw); return { ...row, display_name: row.name } }),
    has_more: false, saved_selection: state[0], native_selector_state: state[0] }
}

// Deliberately memory-only. Each process obtains an authenticated catalog;
// disk caches from another account/provider never authorize a request.
export class DarbCatalogSession {
  private scope: string | undefined
  private catalog: DarbCatalog | undefined
  private generation = 0
  private revision = 0
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getRevision = (): number => this.revision
  private notify(): void {
    this.revision++
    for (const listener of this.listeners) listener()
  }

  hasCatalog(): boolean {
    return this.catalog !== undefined
  }

  current(scope: string | undefined): DarbCatalog | undefined {
    return scope && this.scope === scope ? this.catalog : undefined
  }

  begin(scope: string): number {
    this.scope = scope
    this.catalog = undefined
    const generation = ++this.generation
    this.notify()
    return generation
  }

  complete(scope: string, generation: number, payload: unknown): boolean {
    if (scope !== this.scope || generation !== this.generation) return false
    this.catalog = parseDarbCatalog(payload)
    this.notify()
    return true
  }
}

// Lightweight owner state is initialized before model/settings imports can
// evaluate tool schemas. Keep this module free of those circular dependencies.
export const darbCatalogSession = new DarbCatalogSession()

export function darbBindingHeaders(binding: DarbModelBinding): Record<string, string> {
  return {
    'x-darb-connection-id': binding.connection_id,
    'x-darb-connection-revision': String(binding.connection_revision),
    'x-darb-catalog-revision': binding.catalog_revision,
    'x-darb-context-window-tokens': String(binding.context_window_tokens),
  }
}

export function guardDarbFetch(
  fetcher: DarbFetch,
  origin: string,
  binding: DarbModelBinding | undefined,
  isCurrentAccount: () => boolean,
  beforeRequest?: () => void | Promise<void>,
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
      if (binding && body.model !== binding.id) throw new Error('Darb model changed after request binding')
    }
    await beforeRequest?.()
    if (!isCurrentAccount()) throw new Error('Darb account or session changed; retry in the current session')
    // Strip both public and internal binding headers supplied through custom
    // headers; only this frozen authenticated catalog may supply the binding.
    const headers = new Headers(request.headers)
    const names: string[] = []
    headers.forEach((_value, name) => names.push(name))
    for (const name of names) {
      if (/^x-(darb|sdk)-(connection|catalog|context)-/i.test(name)) headers.delete(name)
    }
    // Explicit default preserves native request semantics. It must not inherit
    // a gateway selector from custom headers or an earlier custom client.
    if (binding) for (const [name, value] of Object.entries(darbBindingHeaders(binding))) headers.set(name, value)
    return fetcher(new Request(request, { headers, redirect: 'error' }))
  }
}
