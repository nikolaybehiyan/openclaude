import { getDarbFrozenModelContext } from './darbFrozenContext.js'

const prefix = 'darb-tool-call-state-v1:'
const field = 'darb_tool_call_state'
const keys = ['scope', 'connection_id', 'model', 'call_id', 'name', 'thought_signature'] as const

// A narrow native-transport extension, not an Anthropic signature, a provider
// selector, or an authorization token. SHA scope is NOT a MAC. The inference
// boundary checks its endpoint binding; the CLI never receives that endpoint.
export function darbToolCallStateFields(block: {
  id: string
  name: string
}): Record<string, string> {
  if (!Object.prototype.hasOwnProperty.call(block, field)) return {}
  const binding = getDarbFrozenModelContext()
  const encoded = (block as unknown as Record<string, unknown>)[field]
  const fail = (): never => { throw new Error('Darb tool call state is invalid or belongs to another frozen model') }
  if (!binding || typeof encoded !== 'string' || !encoded.startsWith(prefix) || Buffer.byteLength(encoded) > 128 * 1024) return fail()
  const base64 = encoded.slice(prefix.length)
  const raw = Buffer.from(base64, 'base64')
  if (raw.toString('base64') !== base64) return fail()
  let state: Record<string, unknown>
  try { state = JSON.parse(raw.toString('utf8')) } catch { return fail() }
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).length !== keys.length ||
      keys.some(key => typeof state[key] !== 'string') ||
      !/^[a-f0-9]{64}$/.test(state.scope as string) ||
      state.connection_id !== binding.connection_id || state.model !== binding.model ||
      state.call_id !== block.id || state.name !== block.name ||
      !state.thought_signature || Buffer.byteLength(state.thought_signature as string) > 64 * 1024) return fail()
  // Only the canonical Go string-only envelope is accepted: this also rejects
  // duplicate keys, unknown fields, malformed UTF-8 and alternate encodings.
  const ordered = Object.fromEntries(keys.map(key => [key, state[key]]))
  const canonical = JSON.stringify(ordered).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  if (!raw.equals(Buffer.from(canonical))) return fail()
  return { [field]: encoded }
}
