import { createHash } from 'node:crypto'
import type { DarbModelBinding } from './darbCatalog.js'

// A persisted selector, never authorization. The authenticated catalog and
// server still authorize every request. Do not persist endpoints or secrets.
export type DarbSessionBinding = Readonly<{
  version: 1
  scope: string
  connection_id: string
  connection_revision: number
}>

export const DARB_SESSION_SELECTION_REQUIRED =
  'This session has no matching Darb connection binding. No history was sent. Run /model and explicitly select a model to use the current connection for this session.'

export function parseDarbSessionBinding(value: unknown): DarbSessionBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.version !== 1 || typeof row.scope !== 'string' || !/^[a-f0-9]{64}$/.test(row.scope) ||
      typeof row.connection_id !== 'string' || !/^icn_[a-f0-9]{32}$/.test(row.connection_id) ||
      !Number.isSafeInteger(row.connection_revision) || Number(row.connection_revision) < 1) return null
  return Object.freeze({ version: 1, scope: row.scope, connection_id: row.connection_id,
    connection_revision: row.connection_revision as number })
}

export function makeDarbSessionBinding(scope: string, model: DarbModelBinding): DarbSessionBinding {
  const binding = parseDarbSessionBinding({ version: 1,
    scope: createHash('sha256').update(scope).digest('hex'),
    connection_id: model.connection_id, connection_revision: model.connection_revision })
  if (!binding) throw new Error(DARB_SESSION_SELECTION_REQUIRED)
  return binding
}

export function sameDarbSessionBinding(a: DarbSessionBinding | null | undefined, b: DarbSessionBinding): boolean {
  return !!a && a.scope === b.scope && a.connection_id === b.connection_id &&
    a.connection_revision === b.connection_revision
}
