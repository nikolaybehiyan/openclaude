// The embedding host owns this process's frozen model contract. This is not a
// provider registry, a model alias, or an inference authorization grant.
import { AsyncLocalStorage } from 'node:async_hooks'
export type DarbNativeParameters = Readonly<{
  version: 1
  thinking_types: readonly ('enabled' | 'disabled' | 'adaptive')[]
  effort_values: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
}>

export type DarbFrozenModelContext = Readonly<{
  owner: 'identity-org-service'
  organization_uuid: string
  account_uuid: string
  mode?: 'default'
  connection_id?: string
  connection_revision?: number
  catalog_revision: string
  model: string
  supports_1m: boolean
  context_window_tokens: 0 | 1000000
  max_context_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  native_parameters?: DarbNativeParameters
}>

function nativeParameters(input: unknown): DarbNativeParameters | undefined {
  if (input === undefined) return undefined
  const v = input as DarbNativeParameters
  const validList = (value: unknown, allowed: string[]) => Array.isArray(value) &&
    value.length <= allowed.length && value.every(x => typeof x === 'string' && allowed.includes(x)) && new Set(value).size === value.length
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.version !== 1 ||
      Object.keys(v).some(k => !['version', 'thinking_types', 'effort_values'].includes(k)) ||
      !validList(v.thinking_types, ['enabled', 'disabled', 'adaptive']) ||
      !validList(v.effort_values, ['low', 'medium', 'high', 'xhigh', 'max'])) {
    throw new Error('Darb frozen native parameters are invalid')
  }
  return Object.freeze({version: 1, thinking_types: Object.freeze([...v.thinking_types]), effort_values: Object.freeze([...v.effort_values])})
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function parseBinding(input: unknown): DarbFrozenModelContext {
  const v = input as Record<string, unknown> | null
  const serverDefault = v?.mode === 'default'
  const parameters = nativeParameters(v?.native_parameters)
  if (parameters && !serverDefault) throw new Error('Darb native parameters require a server default binding')
  const validRoute = serverDefault
    ? v.connection_id === undefined && v.connection_revision === undefined &&
      typeof v.model === 'string' && /^claude-[a-z0-9][a-z0-9._-]*$/.test(v.model) &&
      v.context_window_tokens === 0 && (!v.supports_1m || Number(v.max_input_tokens) >= 1000000) &&
      ['max_context_tokens', 'max_input_tokens', 'max_output_tokens'].every(k => Number.isSafeInteger(v[k]) && Number(v[k]) > 0) &&
      Number(v.max_input_tokens) <= Number(v.max_context_tokens) && Number(v.max_output_tokens) <= Number(v.max_context_tokens)
    : v?.mode === undefined && typeof v?.connection_id === 'string' && /^icn_[a-f0-9]{32}$/.test(v.connection_id) &&
      Number.isSafeInteger(v.connection_revision) && Number(v.connection_revision) >= 1
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.owner !== 'identity-org-service' ||
      !identifier(v.organization_uuid) || !identifier(v.account_uuid) ||
      !validRoute ||
      typeof v.catalog_revision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.catalog_revision) ||
      typeof v.model !== 'string' || v.model.trim() !== v.model || v.model.length === 0 ||
      Buffer.byteLength(v.model) > 256 || /[\p{Cc}]/u.test(v.model) ||
      typeof v.supports_1m !== 'boolean' ||
      (v.context_window_tokens !== 0 && v.context_window_tokens !== 1000000) ||
      (v.max_context_tokens !== undefined && (!Number.isSafeInteger(v.max_context_tokens) || Number(v.max_context_tokens) <= 0)) ||
      (v.max_input_tokens !== undefined && (!Number.isSafeInteger(v.max_input_tokens) || Number(v.max_input_tokens) <= 0)) ||
      (v.max_output_tokens !== undefined && (!Number.isSafeInteger(v.max_output_tokens) || Number(v.max_output_tokens) <= 0)) ||
      (v.context_window_tokens === 1000000 && (!v.supports_1m || v.max_input_tokens !== undefined && Number(v.max_input_tokens) < 1000000 || v.max_context_tokens !== undefined && Number(v.max_context_tokens) < 1000000))) {
    throw new Error('Darb frozen model context is invalid')
  }
  // Copy only public binding metadata; never retain an endpoint or credential.
  return Object.freeze({
    owner: 'identity-org-service', organization_uuid: v.organization_uuid,
    account_uuid: v.account_uuid,
    ...(serverDefault ? { mode: 'default' as const } : { connection_id: v.connection_id as string, connection_revision: v.connection_revision as number }),
    catalog_revision: v.catalog_revision,
    model: v.model, supports_1m: v.supports_1m, context_window_tokens: v.context_window_tokens,
    ...(v.max_context_tokens !== undefined ? { max_context_tokens: v.max_context_tokens as number } : {}),
    ...(v.max_input_tokens !== undefined ? { max_input_tokens: v.max_input_tokens as number } : {}),
    ...(v.max_output_tokens !== undefined ? { max_output_tokens: v.max_output_tokens as number } : {}),
    ...(parameters ? {native_parameters: parameters} : {}),
  })
}

export class DarbFrozenContextRegistry {
  private binding: DarbFrozenModelContext | undefined

  configure(input: unknown): DarbFrozenModelContext {
    const next = parseBinding(input)
    if (this.binding && JSON.stringify(this.binding) !== JSON.stringify(next)) {
      throw new Error('Darb frozen model context changed; restart the runtime process')
    }
    return this.binding ??= next
  }

  get(model?: string): DarbFrozenModelContext | undefined {
    if (this.binding && model !== undefined && model !== this.binding.model) {
      throw new Error('Darb frozen model context exact model mismatch')
    }
    return this.binding
  }
}

const processRegistry = new DarbFrozenContextRegistry()
const invocationContext = new AsyncLocalStorage<DarbFrozenModelContext>()
// Code's launcher supplies this at spawn. Capture it before settings.env is
// applied; later environment changes cannot rebind an already running process.
const bootstrap = process.env.DARB_FROZEN_MODEL_CONTEXT_JSON
if (bootstrap !== undefined) {
  if (process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST !== '1') {
    throw new Error('Darb frozen model context requires a managed host')
  }
  if (Buffer.byteLength(bootstrap) > 8192) throw new Error('Darb frozen model context is invalid')
  processRegistry.configure(JSON.parse(bootstrap))
}

// Embedded SDK hosts call this immediately after import, before creating any
// session. The process can be rebound only by starting a new process.
export function configureDarbFrozenModelContext(input: unknown): DarbFrozenModelContext {
  return processRegistry.configure(input)
}

export function getDarbFrozenModelContext(model?: string): DarbFrozenModelContext | undefined {
  const invocation = invocationContext.getStore()
  if (invocation) {
    if (model !== undefined && model !== invocation.model) throw new Error('Darb frozen model context exact model mismatch')
    return invocation
  }
  return processRegistry.get(model)
}

// Stateless embedded hosts serve different authenticated owners concurrently.
// Scope metadata to the entire SDK tool loop; never rebind global process state.
export function runWithDarbFrozenModelContext<T>(input: unknown, run: () => T): T {
  const next = parseBinding(input)
  const existing = getDarbFrozenModelContext()
  if (existing && JSON.stringify(existing) !== JSON.stringify(next)) throw new Error('Darb frozen model context changed inside an invocation')
  return invocationContext.run(next, run)
}

// Only a host-frozen contract overrides native model-family heuristics. Missing
// metadata retains the old behavior; an explicit empty list means unsupported.
export function getDarbNativeParameters(model: string): DarbNativeParameters | undefined {
  return getDarbFrozenModelContext(model)?.native_parameters
}
