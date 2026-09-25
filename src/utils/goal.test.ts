import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import type { AppState } from '../state/AppStateStore.js'
import type { LocalJSXCommandContext } from '../types/command.js'
import { getSessionId } from '../bootstrap/state.js'
import { addSessionHook } from './hooks/sessionHooks.js'
const hooks = await import('./hooks.js')
const config = await import('./hooks/hooksConfigSnapshot.js')
let restricted = false, managed = false, untrusted = false
mock.module('./hooks.js', () => ({...hooks, shouldSkipHookDueToTrust: () => untrusted}))
mock.module('./hooks/hooksConfigSnapshot.js', () => ({...config,
  shouldDisableAllHooksIncludingManaged: () => restricted, shouldAllowManagedHooksOnly: () => managed}))
const { getGoalHooks, getLastAchievedGoal, hasGoalBackgroundWork, MAX_GOAL_LENGTH, findGoalToRestore, restoreGoalFromTranscript } = await import('./goal.js')
const { call } = await import('../commands/goal/goal-noninteractive.js')
const { goalNonInteractive } = await import('../commands/goal/index.js')
const { processSlashCommand } = await import('./processUserInput/processSlashCommand.js')
afterAll(() => mock.restore())
beforeEach(() => {restricted = managed = untrusted = false})

function fixture() {
  let state = {sessionHooks: new Map(), tasks: {}} as unknown as AppState
  let messages: unknown[] = []
  const context = {getAppState: () => state, setAppState: (update: (s:AppState) => AppState) => {state = update(state)},
    setMessages: (update: (m:unknown[]) => unknown[]) => {messages = update(messages)}, options: {}, messages} as unknown as LocalJSXCommandContext
  return {context, state: () => state, messages: () => messages}
}

test('goal command sets a session hook and immediately supplies the real query directive', async () => {
  const f = fixture()
  expect(await call('', f.context)).toEqual({type: 'text', value: 'No goal set. Usage: `/goal <condition>`'})
  const result = await call('  All checks pass  ', f.context)
  expect(result.type).toBe('query')
  if (result.type === 'query') expect(result.prompt).toContain('immediately start (or continue)')
  expect(f.state().activeGoal).toMatchObject({condition: 'All checks pass', iterations: 0})
  expect(getGoalHooks(f.state())).toEqual([{type: 'prompt', prompt: 'All checks pass'}])
  expect(f.messages()).toHaveLength(1)
  expect(getLastAchievedGoal(f.messages())).toBeNull()
  expect((await call('', f.context)).value).toContain('not yet evaluated')
})

test('the actual slash-command dispatcher forwards the goal query to the model loop', async () => {
  const f = fixture()
  f.context.options.commands = [goalNonInteractive]
  f.context.options.isNonInteractiveSession = true
  const result = await processSlashCommand('/goal Check all tests', [], [], [], f.context, () => {})
  expect(result.shouldQuery).toBe(true)
  expect(result.messages.some((message:any) => message.isMeta && message.message?.content.includes('session-scoped Stop hook'))).toBe(true)
  expect(f.state().activeGoal?.condition).toBe('Check all tests')
  const cleared = await processSlashCommand('/goal clear', [], [], [], f.context, () => {})
  expect(cleared.shouldQuery).toBe(false)
  expect(f.state().activeGoal).toBeUndefined()
})

test('replacement and every clear alias preserve scoped skill hooks, function hooks and other sessions', async () => {
  for (const alias of ['CLEAR', 'stop', 'off', 'reset', 'none', 'cancel']) {
    const f = fixture(), session = getSessionId()
    addSessionHook(f.context.setAppState, session, 'Stop', '', {type: 'prompt', prompt: 'skill'}, undefined, '/skill')
    addSessionHook(f.context.setAppState, session, 'Stop', 'specific', {type: 'prompt', prompt: 'matched'})
    addSessionHook(f.context.setAppState, 'other', 'Stop', '', {type: 'prompt', prompt: 'other session'})
    await call('first', f.context); await call('second', f.context)
    expect(getGoalHooks(f.state())).toEqual([{type: 'prompt', prompt: 'second'}])
    expect((await call(alias, f.context)).value).toBe('Goal cleared: second')
    expect(f.state().activeGoal).toBeUndefined()
    expect(getGoalHooks(f.state())).toEqual([])
    expect(getGoalHooks(f.state(), 'other')).toHaveLength(1)
    expect(f.state().sessionHooks.get(session)?.hooks.Stop).toHaveLength(2)
    expect(getLastAchievedGoal(f.messages())).toBeNull()
  }
})

test('trust/policy and exact 4000 UTF-16 character limit reject without mutations', async () => {
  const f = fixture()
  for (const mode of ['restricted', 'managed', 'untrusted']) {
    restricted = mode === 'restricted'; managed = mode === 'managed'; untrusted = mode === 'untrusted'
    expect((await call('Build it', f.context)).value).toMatch(/restricted|trusted/)
    expect(f.state().activeGoal).toBeUndefined(); expect(f.messages()).toEqual([])
  }
  restricted = managed = untrusted = false
  expect((await call('x'.repeat(MAX_GOAL_LENGTH + 1), f.context)).value).toContain('4001')
  expect((await call('x'.repeat(MAX_GOAL_LENGTH), f.context)).type).toBe('query')
})

test('achievement lookup ignores clear sentinels and failed checks; active background task semantics match pinned source', () => {
  const achieved = {type: 'goal_status', met: true, condition: 'done', iterations: 2} as const
  expect(getLastAchievedGoal([{type:'attachment',attachment:achieved},
    {type:'attachment',attachment:{type:'goal_status',met:true,sentinel:true,condition:'cleared'}}])).toEqual(achieved)
  for (const type of ['local_agent','remote_agent','local_workflow','local_bash','in_process_teammate']) {
    for (const status of ['pending','running','paused']) expect(hasGoalBackgroundWork({a:{type,status}})).toBe(true)
    for (const status of ['completed','failed','killed']) expect(hasGoalBackgroundWork({a:{type,status}})).toBe(false)
  }
  expect(hasGoalBackgroundWork({a:{type:'in_process_teammate',status:'running',isIdle:true}})).toBe(false)
  expect(hasGoalBackgroundWork({a:{type:'remote_agent',status:'running',isLongRunning:true}})).toBe(false)
  expect(hasGoalBackgroundWork({a:{type:'monitor_mcp',status:'running'}})).toBe(false)
})


test('resume restores the latest unfinished goal once and terminal markers prevent revival', async () => {
  const f=fixture()
  const pending={type:'attachment',attachment:{type:'goal_status',met:false,sentinel:true,condition:'resume goal'}}
  expect(findGoalToRestore([pending])).toBe('resume goal')
  restoreGoalFromTranscript([pending],f.context.setAppState)
  restoreGoalFromTranscript([pending],f.context.setAppState)
  expect(getGoalHooks(f.state())).toEqual([{type:'prompt',prompt:'resume goal'}])
  expect(f.state().activeGoal).toMatchObject({condition:'resume goal',iterations:0})
  expect(f.messages()).toEqual([])
  for(const status of [{met:true},{met:true,sentinel:true},{met:false,failed:true}]){
    const history=[pending,{type:'attachment',attachment:{type:'goal_status',condition:'resume goal',...status}}]
    expect(findGoalToRestore(history)).toBeNull()
    restoreGoalFromTranscript(history,f.context.setAppState)
    expect(f.state().activeGoal).toBeUndefined()
    expect(getGoalHooks(f.state())).toEqual([])
  }
  for(const policy of ['restricted','managed','untrusted']){
    restricted=policy==='restricted';managed=policy==='managed';untrusted=policy==='untrusted'
    restoreGoalFromTranscript([pending],f.context.setAppState)
    expect(f.state().activeGoal).toBeUndefined()
    expect(getGoalHooks(f.state())).toEqual([])
  }
})
