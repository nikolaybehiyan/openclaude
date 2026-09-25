import {expect,test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import type {AppState} from '../../state/AppStateStore.js'
import {createRemoteGoalController,type GoalHistoryPage} from './remote.js'
const goal={condition:'remote goal',iterations:2,set_at:123,tokens_at_start:7}
const message=(value:typeof goal|null,session_id='test')=>({type:'active_goal',value,session_id,uuid:randomUUID()})
const page=(events:unknown[],hasMore=false,firstId:string|null=null):GoalHistoryPage=>({events,hasMore,firstId})
function fixture(){
 let state={activeGoal:undefined} as unknown as AppState
 const controller=createRemoteGoalController(update=>{state=update(state)},'test')
 return {controller,state:()=>state}
}

test('remote state adopts valid goal/clear, consumes invalid frames, and ignores other sessions',()=>{
 const f=fixture()
 expect(f.controller.receive({type:'assistant'})).toBe(false)
 expect(f.controller.receive(message(goal))).toBe(true)
 expect(f.state().activeGoal).toMatchObject({condition:'remote goal',iterations:2})
 f.controller.receive(message(null,'other'))
 f.controller.receive({...message(null),value:{condition:42}})
 expect(f.state().activeGoal?.condition).toBe('remote goal')
 f.controller.receive(message(null));expect(f.state().activeGoal).toBeUndefined()
})

test('history can find the latest goal on older pages and respects clear/reset boundaries',async()=>{
 for(const terminal of [message(null),{type:'conversation_reset'}]){
  const f=fixture();f.controller.receive(message(goal))
  await f.controller.refresh({latest:async()=>page([message(goal),terminal]),older:async()=>{throw Error('unexpected pagination')}})
  expect(f.state().activeGoal).toBeUndefined()
 }
 const f=fixture(),cursors:string[]=[]
 await f.controller.refresh({latest:async()=>page([{type:'assistant'}],true,'older'),older:async cursor=>{cursors.push(cursor);return page([message(goal)])}})
 expect(cursors).toEqual(['older']);expect(f.state().activeGoal?.condition).toBe('remote goal')
})

test('live goal/clear, disconnect and a newer refresh win over slow initial history',async()=>{
 for(const action of ['live','clear','dispose','refresh']){
  const f=fixture(),pending=Promise.withResolvers<GoalHistoryPage>()
  const old=f.controller.refresh({latest:()=>pending.promise,older:async()=>null})
  if(action==='live')f.controller.receive(message({...goal,condition:'new goal'}))
  if(action==='clear')f.controller.receive(message(null))
  if(action==='dispose')f.controller.dispose()
  if(action==='refresh')await f.controller.refresh({latest:async()=>page([message({...goal,condition:'new goal'})]),older:async()=>null})
  pending.resolve(page([message(goal)]));await old
  expect(f.state().activeGoal?.condition).toBe(action==='live'||action==='refresh'?'new goal':undefined)
 }
})

test('partial, failed and cyclic history never proves goal completion',async()=>{
 const f=fixture();f.controller.receive(message(goal))
 await f.controller.refresh({latest:async()=>null,older:async()=>null})
 expect(f.state().activeGoal?.condition).toBe('remote goal')
 await f.controller.refresh({latest:async()=>page([],true,'same'),older:async()=>page([],true,'same')})
 expect(f.state().activeGoal?.condition).toBe('remote goal')
 await f.controller.refresh({latest:async()=>{throw Error('offline')},older:async()=>null})
 expect(f.state().activeGoal?.condition).toBe('remote goal')
 await f.controller.refresh({latest:async()=>page([]),older:async()=>null})
 expect(f.state().activeGoal).toBeUndefined()
})


test('old connection disposal, live events and in-flight history cannot change the new session', async()=>{
 let state={activeGoal:undefined} as unknown as AppState
 const setState=(update:(state:AppState)=>AppState)=>{state=update(state)}
 const first=createRemoteGoalController(setState,'first')
 first.receive(message(goal,'first'))
 const pending=Promise.withResolvers<GoalHistoryPage>()
 const refresh=first.refresh({latest:()=>pending.promise,older:async()=>null})
 const second=createRemoteGoalController(setState,'second')
 second.receive(message({...goal,condition:'second session'},'second'))
 first.clear()
 first.receive(message({...goal,condition:'late first session'},'first'))
 first.dispose()
 pending.resolve(page([message(goal,'first')]))
 await refresh
 expect(state.activeGoal?.condition).toBe('second session')
 second.dispose()
 expect(state.activeGoal).toBeUndefined()
})

test('history search is bounded to 25 pages and never treats the limit as completion',async()=>{
 const f=fixture();f.controller.receive(message(goal))
 let calls=0
 await f.controller.refresh({latest:async()=>{calls++;return page([],true,'1')},
   older:async()=>{calls++;return page([],true,String(calls))}})
 expect(calls).toBe(25)
 expect(f.state().activeGoal?.condition).toBe('remote goal')
})
