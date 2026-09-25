/**
 * Stub — query source enum not included in source snapshot. See
 * src/types/message.ts for the same scoping caveat (issue #473).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type QuerySource = any

/** Query-loop category used to exclude bookkeeping queries from enforcement. */
export function getQueryCategory(
  source: string | undefined,
): 'main' | 'subagent' | 'auxiliary' | undefined {
  if (source === undefined) return undefined
  if (source.startsWith('repl_main_thread') || source === 'sdk') return 'main'
  if (source.startsWith('agent:') || source === 'hook_agent') return 'subagent'
  return 'auxiliary'
}
