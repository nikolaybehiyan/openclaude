import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../Tool.js'
import { getQueryCategory } from '../constants/querySource.js'

const previousBare = process.env.CLAUDE_CODE_SIMPLE
const hooks = await import('../utils/hooks.js')
let hookMode: 'empty' | 'prevent' | 'abort' | 'throw' = 'empty'
let controller = new AbortController()
mock.module('../utils/hooks.js', () => ({
  ...hooks,
  executeStopHooks: async function* () {
    if (hookMode === 'prevent') yield { preventContinuation: true }
    if (hookMode === 'abort') {
      controller.abort()
      yield {}
    }
    if (hookMode === 'throw') throw new Error('fixture hook failure')
  },
}))
const { handleStopHooks } = await import('./stopHooks.js')

beforeEach(() => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  controller = new AbortController()
  hookMode = 'empty'
})
afterAll(() => {
  mock.restore()
  if (previousBare === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = previousBare
})

const user = (content = 'Return a bank change specification') => ({
  type: 'user', message: { role: 'user', content },
})
const call = (id: string, name = 'StructuredOutput') => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] },
})
const result = (id: string, isError = false) => ({
  type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: '{}' }] },
})

async function stop(messages: unknown[], assistantMessages: unknown[] = [], required = true, source: string | undefined = 'agent:custom') {
  const context = {
    options: { requiresStructuredOutput: required },
    abortController: controller,
    getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
  } as unknown as ToolUseContext
  const stream = handleStopHooks(messages, assistantMessages, [], {}, {}, context, source)
  const yielded = []
  while (true) {
    const next = await stream.next()
    if (next.done) return { ...next.value, yielded }
    yielded.push(next.value)
  }
}

test('missing structured result gets one nudge per real user turn', async () => {
  const first = await stop([user()])
  expect(first.preventContinuation).toBe(false)
  expect(first.blockingErrors).toHaveLength(1)
  const nudge = first.blockingErrors[0]
  expect(first.yielded).toContain(nudge)
  expect(nudge.isMeta).toBe(true)
  expect(nudge.message.content).toContain('[structured-output-enforce]')
  expect((await stop([user(), nudge, call('failed'), result('failed', true)])).blockingErrors).toEqual([])
  expect((await stop([user(), nudge, user('Now produce a different specification')])).blockingErrors).toHaveLength(1)
})

test('only a successful matching result in this turn satisfies the requirement', async () => {
  expect((await stop([user(), call('ok'), result('ok')])).blockingErrors).toEqual([])
  expect((await stop([user(), call('pending')])).blockingErrors).toHaveLength(1)
  expect((await stop([user(), call('a'), result('b')])).blockingErrors).toHaveLength(1)
  expect((await stop([user(), call('ok'), result('ok'), user('Next task')])).blockingErrors).toHaveLength(1)
  expect((await stop([user(), call('ok'), result('ok')], [call('latest')])).blockingErrors).toHaveLength(1)
  expect((await stop([user(), call('ok'), result('ok'), call('bad'), result('bad', true)])).blockingErrors).toHaveLength(1)
})

test('ordinary tools and meta context do not become a new user turn', async () => {
  const messages = [user(), call('ok'), result('ok'),
    { ...user('Additional context'), isMeta: true }, call('read', 'Read'), result('read')]
  expect((await stop(messages)).blockingErrors).toEqual([])
  expect((await stop([user(), call('read', 'Read'), result('read')])).blockingErrors).toHaveLength(1)
})

test('requirement is opt-in and excludes auxiliary work', async () => {
  expect((await stop([user()], [], false)).blockingErrors).toEqual([])
  for (const source of ['compact', 'session_memory', 'prompt_suggestion', 'side_question']) {
    expect((await stop([user()], [], true, source)).blockingErrors).toEqual([])
  }
  for (const source of ['sdk', 'repl_main_thread', 'repl_main_thread:outputStyle:custom', 'agent:custom', 'hook_agent']) {
    expect((await stop([user()], [], true, source)).blockingErrors).toHaveLength(1)
  }
  expect(getQueryCategory(undefined)).toBeUndefined()
})

test('Stop prevention and cancellation override the pending nudge', async () => {
  for (const mode of ['prevent', 'abort'] as const) {
    hookMode = mode
    const stopped = await stop([user()])
    expect(stopped.preventContinuation).toBe(true)
    expect(stopped.blockingErrors).toEqual([])
  }
})

test('hook failure preserves the independent structured-output requirement', async () => {
  hookMode = 'throw'
  const stopped = await stop([user()])
  expect(stopped.preventContinuation).toBe(false)
  expect(stopped.blockingErrors).toHaveLength(1)
  expect(stopped.yielded.some(message => message.type === 'system')).toBe(true)
})
