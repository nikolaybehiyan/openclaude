// The embedding host owns this process's frozen model contract. This is not a
// provider registry, a model alias, or an inference authorization grant.
export type DarbFrozenModelContext = Readonly<{
  owner: 'identity-org-service'
  organization_uuid: string
  account_uuid: string
  connection_id: string
  connection_revision: number
  catalog_revision: string
  model: string
  supports_1m: boolean
  context_window_tokens: 0 | 1000000
  max_context_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
}>

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function parseBinding(input: unknown): DarbFrozenModelContext {
  const v = input as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.owner !== 'identity-org-service' ||
      !identifier(v.organization_uuid) || !identifier(v.account_uuid) ||
      typeof v.connection_id !== 'string' || !/^icn_[a-f0-9]{32}$/.test(v.connection_id) ||
      !Number.isSafeInteger(v.connection_revision) || Number(v.connection_revision) < 1 ||
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
    account_uuid: v.account_uuid, connection_id: v.connection_id,
    connection_revision: v.connection_revision as number, catalog_revision: v.catalog_revision,
    model: v.model, supports_1m: v.supports_1m, context_window_tokens: v.context_window_tokens,
    ...(v.max_context_tokens !== undefined ? { max_context_tokens: v.max_context_tokens as number } : {}),
    ...(v.max_input_tokens !== undefined ? { max_input_tokens: v.max_input_tokens as number } : {}),
    ...(v.max_output_tokens !== undefined ? { max_output_tokens: v.max_output_tokens as number } : {}),
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
  return processRegistry.get(model)
}
