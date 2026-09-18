import { createHash } from 'node:crypto'
import type { DarbModelBinding } from './darbCatalog.js'
import { parseDarbNativeThinking, type DarbNativeThinking } from './darbModelControls.js'

// A persisted selector, never authorization. The authenticated catalog and
// server still authorize every request. Do not persist endpoints or secrets.
export type DarbCustomSessionBinding = Readonly<{
  version: 1
  scope: string
  connection_id: string
  connection_revision: number
  // Main conversation choice; helper/agent requests must never replace it.
  selected_model?: string
  // Local session preferences, not account-global state or authorization.
  controls_by_model?: readonly Readonly<{ model: string; thinking: DarbNativeThinking | null }>[]
}>
export type DarbDefaultSessionBinding = Readonly<{
  version: 2
  mode: 'default'
  scope: string
}>
export type DarbSessionBinding = DarbCustomSessionBinding | DarbDefaultSessionBinding

export const DARB_SESSION_SELECTION_REQUIRED =
  'This session has no matching Darb connection binding. No history was sent. Run /model and explicitly select a model to use the current connection for this session.'

export function parseDarbSessionBinding(value: unknown): DarbSessionBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.version === 2 && row.mode === 'default' && typeof row.scope === 'string' && /^[a-f0-9]{64}$/.test(row.scope) &&
      row.connection_id === undefined && row.connection_revision === undefined) {
    return Object.freeze({ version: 2, mode: 'default', scope: row.scope })
  }
  if (row.version !== 1 || typeof row.scope !== 'string' || !/^[a-f0-9]{64}$/.test(row.scope) ||
      typeof row.connection_id !== 'string' || !/^icn_[a-f0-9]{32}$/.test(row.connection_id) ||
      !Number.isSafeInteger(row.connection_revision) || Number(row.connection_revision) < 1) return null
  if (row.selected_model !== undefined && (typeof row.selected_model !== 'string' ||
      !row.selected_model.length || row.selected_model.length > 512 ||
      row.selected_model.trim() !== row.selected_model || /[\p{Cc}]/u.test(row.selected_model))) return null
  let controls: DarbCustomSessionBinding['controls_by_model']
  if (row.controls_by_model !== undefined) {
    if (!Array.isArray(row.controls_by_model) || row.controls_by_model.length > 1000) return null
    const seen = new Set<string>()
    try {
      controls = Object.freeze(row.controls_by_model.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.model !== 'string' ||
            value.model.length === 0 || value.model.length > 512 || value.model.trim() !== value.model || /[\p{Cc}]/u.test(value.model) || seen.has(value.model)) throw new Error('Invalid local model control state')
        seen.add(value.model)
        return Object.freeze({ model: value.model, thinking: parseDarbNativeThinking(value.thinking) })
      }))
    } catch { return null }
  }
  return Object.freeze({ version: 1, scope: row.scope, connection_id: row.connection_id,
    connection_revision: row.connection_revision as number,
    ...(row.selected_model === undefined ? {} : { selected_model: row.selected_model as string }),
    ...(controls ? { controls_by_model: controls } : {}) })
}

// Restore a preference, not authorization. The live catalog and connection
// binding are still checked before any resumed history leaves the process.
export function darbModelForResume(value: unknown, custom: boolean, explicitModel: string | null | undefined): string | undefined {
  if (!custom || explicitModel !== undefined) return undefined
  const binding = parseDarbSessionBinding(value)
  return binding?.version === 1 ? binding.selected_model : undefined
}

export function isDarbMainConversationSource(source: string | undefined): boolean {
  return source === 'sdk' || source?.startsWith('repl_main_thread') === true
}

export function makeDarbSessionBinding(scope: string, model: DarbModelBinding): DarbCustomSessionBinding {
  const binding = parseDarbSessionBinding({ version: 1,
    scope: createHash('sha256').update(scope).digest('hex'),
    connection_id: model.connection_id, connection_revision: model.connection_revision })
  if (!binding || binding.version !== 1) throw new Error(DARB_SESSION_SELECTION_REQUIRED)
  return binding
}

export function sameDarbSessionBinding(a: DarbSessionBinding | null | undefined, b: DarbSessionBinding): boolean {
  return !!a && a.scope === b.scope && a.version === b.version &&
    (a.version === 2 && b.version === 2 || a.version === 1 && b.version === 1 &&
      a.connection_id === b.connection_id && a.connection_revision === b.connection_revision)
}

export function makeDarbDefaultSessionBinding(scope: string): DarbDefaultSessionBinding {
  return Object.freeze({ version: 2, mode: 'default', scope: createHash('sha256').update(scope).digest('hex') })
}

// A lazy reader avoids importing transcript/settings machinery while tool
// schemas initialize. It always reads the current project/session, never a
// cached binding from a previously opened transcript.
let sessionReader: (() => DarbSessionBinding | null | undefined) | undefined
export function registerDarbSessionBindingReader(reader: typeof sessionReader): void { sessionReader = reader }
export function readDarbSessionThinking(scope: string, model: DarbModelBinding): DarbNativeThinking | null | undefined {
  const current = sessionReader?.()
  if (current?.version !== 1 || !sameDarbSessionBinding(current, makeDarbSessionBinding(scope, model))) return undefined
  return current.controls_by_model?.find(entry => entry.model === model.id)?.thinking
}
