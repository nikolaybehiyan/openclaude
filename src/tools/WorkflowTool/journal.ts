import { createHash } from 'node:crypto'

export type WorkflowStartedRecord = {type: 'started'; key: string; agentId: string}
export type WorkflowResultRecord = {type: 'result'; key: string; agentId: string; result: unknown}
export type WorkflowJournalRecord = WorkflowStartedRecord | WorkflowResultRecord
export type WorkflowJournalIndex = {
  results: Map<string, WorkflowResultRecord>
  started: Map<string, WorkflowStartedRecord[]>
}

// Valid-record folding matches 2.1.226 jNp: last completed result wins, every
// started attempt is retained. A start without a result is retryable, not proof
// that a child or its external side effects never ran. The runner must enforce
// run ownership, script fingerprint and exclusive resume before using an index.
export function indexWorkflowJournal(records: readonly WorkflowJournalRecord[]): WorkflowJournalIndex {
  const results = new Map<string, WorkflowResultRecord>()
  const started = new Map<string, WorkflowStartedRecord[]>()
  for (const record of records) {
    if (record.type === 'result') results.set(record.key, record)
    else if (record.type === 'started') {
      const attempts = started.get(record.key) ?? []
      attempts.push(record)
      started.set(record.key, attempts)
    }
  }
  return {results, started}
}

// Input MUST be a host-owned snapshot produced by the VM membrane, not a
// directly accessed VM object/proxy. These are the only options included in
// the official v2 invocation identity; presentation and retry timing are not.
export function workflowInvocationOptions(snapshot?: Record<string, unknown>): string {
  const selected: Record<string, unknown> = {}
  for (const name of ['schema', 'model', 'effort', 'isolation', 'agentType']) {
    const value = snapshot?.[name]
    if (value !== undefined && typeof value !== 'function') selected[name] = value
  }
  function canonical(value: unknown): unknown {
    if (typeof value === 'function') return undefined
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(value).sort()) {
        if (key !== '__proto__') result[key] = canonical((value as Record<string, unknown>)[key])
      }
      return result
    }
    return value
  }
  return JSON.stringify(canonical(selected))
}

export function workflowInvocationKey(prompt: string, snapshot: Record<string, unknown> | undefined, callSite: string): string {
  return 'v2:' + createHash('sha256').update(callSite).update('\0').update(prompt).update('\0')
    .update(workflowInvocationOptions(snapshot)).digest('hex')
}
