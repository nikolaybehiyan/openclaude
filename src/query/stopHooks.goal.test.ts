import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { getSessionId } from '../bootstrap/state.js'
import type { ToolUseContext } from '../Tool.js'
import type { AppState } from '../state/AppStateStore.js'
import { addSessionHook, removeSessionHook } from '../utils/hooks/sessionHooks.js'
import { clearSessionGoal, getGoalHooks } from '../utils/goal.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
const hooks = await import('../utils/hooks.js')
let run: (...args: any[]) => AsyncGenerator<any> = async function* () {}
mock.module('../utils/hooks.js', () => ({...hooks, executeStopHooks: (...args: any[]) => run(...args)}))
const {handleStopHooks} = await import('./stopHooks.js')
const previous = process.env.CLAUDE_CODE_SIMPLE
beforeEach(() => {process.env.CLAUDE_CODE_SIMPLE = '1'})
afterAll(() => {mock.restore(); if (previous === undefined) delete process.env.CLAUDE_CODE_SIMPLE; else process.env.CLAUDE_CODE_SIMPLE = previous})
function fixture(tasks: Record<string, any> = {}) {
  let state = {sessionHooks:new Map(), tasks, toolPermissionContext:{mode:'default'},
    activeGoal:{condition:'tests pass',iterations:0,setAt:Date.now()-10,tokensAtStart:0}} as unknown as AppState
  const context = {options:{}, abortController:new AbortController(), getAppState:()=>state,
    setAppState:(update:(s:AppState)=>AppState)=>{state=update(state)}} as unknown as ToolUseContext
  const hook = {type:'prompt' as const,prompt:'tests pass'}
  addSessionHook(context.setAppState,getSessionId(),'Stop','',hook)
  return {context,hook,state:()=>state}
}
async function drain(f: ReturnType<typeof fixture>) {
  const iterator=handleStopHooks([],[],asSystemPrompt([]),{},{},f.context,'sdk'), events:any[]=[]
  for (;;) {
    const next=await iterator.next()
    if(next.done)return{...next.value,events}
    events.push(next.value)
    if(next.value.type==='active_goal')f.context.setAppState(s=>({...s,activeGoal:next.value.value}))
  }
}
test('unmet condition continues and updates goal reason; success and impossible clear with different outcomes',async()=>{
  for(const outcome of ['blocking','success','impossible']){
    const f=fixture()
    run=async function*(){
      if(outcome==='blocking')yield{hook:f.hook,blockingError:{blockingError:'missing test result',command:f.hook.prompt},stopReason:'missing test result'}
      else yield{hook:f.hook,impossible:outcome==='impossible',stopReason:'evidence',message:{type:'attachment',attachment:{type:'hook_success',hookEvent:'Stop',content:''}}}
    }
    const result=await drain(f), status=result.events.find(e=>e.attachment?.type==='goal_status')?.attachment
    expect(result.preventContinuation).toBe(false)
    if(outcome==='blocking'){
      expect(result.blockingErrors).toHaveLength(1)
      expect(f.state().activeGoal).toMatchObject({iterations:1,lastReason:'missing test result'})
      expect(status.met).toBe(false);expect(getGoalHooks(f.state())).toHaveLength(1)
    }else{
      expect(f.state().activeGoal).toBeUndefined();expect(getGoalHooks(f.state())).toEqual([])
      expect(status).toMatchObject({met:outcome==='success',iterations:1,condition:'tests pass'})
      expect(status.failed).toBe(outcome==='impossible'?true:undefined)
    }
  }
})
test('background work defers only the goal and restores it even when the hook runner throws',async()=>{
  const f=fixture({w:{type:'local_workflow',status:'running'}})
  run=async function*(){expect(getGoalHooks(f.state())).toEqual([]);throw Error('fixture exception')}
  await drain(f)
  expect(getGoalHooks(f.state())).toEqual([f.hook]);expect(f.state().activeGoal?.iterations).toBe(0)
})
test('the real clear command can cancel a goal whose hook is temporarily deferred',async()=>{
  const f=fixture({w:{type:'local_workflow',status:'running'}})
  run=async function*(){
    expect(getGoalHooks(f.state())).toEqual([])
    expect(clearSessionGoal({...f.context,setMessages:()=>{}})).toBe('tests pass')
  }
  await drain(f)
  expect(f.state().activeGoal).toBeUndefined()
  expect(getGoalHooks(f.state())).toEqual([])
})
test('a cleared or replaced goal is never resurrected or completed by an in-flight check',async()=>{
  for(const background of [true,false]){
    const f=fixture(background?{w:{type:'local_agent',status:'running'}}:{})
    run=async function*(){
      removeSessionHook(f.context.setAppState,getSessionId(),'Stop',f.hook)
      f.context.setAppState(s=>({...s,activeGoal:{...s.activeGoal!,condition:'tests pass'}}))
      addSessionHook(f.context.setAppState,getSessionId(),'Stop','',f.hook)
      yield{hook:f.hook,message:{type:'attachment',attachment:{type:'hook_success',hookEvent:'Stop',content:''}}}
    }
    const result=await drain(f)
    expect(result.events.filter(e=>e.type==='active_goal')).toEqual([])
    expect(getGoalHooks(f.state())).toHaveLength(1)
    expect(f.state().activeGoal?.iterations).toBe(0)
  }
})
test('subagent stop and nonblocking evaluator failure leave the main goal alone',async()=>{
  const f=fixture();f.context.agentId='child' as any
  run=async function*(){yield{hook:f.hook,message:{type:'attachment',attachment:{type:'hook_success',hookEvent:'SubagentStop',content:''}}}}
  expect((await drain(f)).events.some(e=>e.type==='active_goal')).toBe(false)
  expect(getGoalHooks(f.state())).toHaveLength(1)
})

test('clearing a goal during its check cannot force another turn from the stale blocking result',async()=>{
  const f=fixture()
  run=async function*(){
    removeSessionHook(f.context.setAppState,getSessionId(),'Stop',f.hook)
    f.context.setAppState(s=>({...s,activeGoal:undefined}))
    yield{hook:f.hook,blockingError:{blockingError:'old goal still incomplete',command:f.hook.prompt}}
  }
  const result=await drain(f)
  expect(result.blockingErrors).toEqual([])
  expect(result.events.some(e=>e.type==='active_goal')).toBe(false)
})
