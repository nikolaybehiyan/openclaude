import {expect,test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {query, unstable_v2_resumeSession} from '../../src/entrypoints/sdk/index.js'
import {getSessionId, runWithSdkContext, setIsInteractive} from '../../src/bootstrap/state.js'
import {getGoalHooks} from '../../src/utils/goal.js'
import {withTempDir,createSessionJsonl,createMinimalConversation,collectMessages} from './helpers/query-test-doubles.js'
import {MockQueryEngine} from './helpers/mock-engine.js'

function transcript(sessionId:string, terminal?:Record<string,unknown>) {
 const messages=createMinimalConversation(sessionId)
 messages.push({type:'attachment',uuid:randomUUID(),parentUuid:messages.at(-1)!.uuid,sessionId,
  timestamp:'2026-09-25T00:00:00Z',attachment:{type:'goal_status',condition:'finish fixture',met:false,sentinel:true}})
 if(terminal)messages.push({type:'attachment',uuid:randomUUID(),parentUuid:messages.at(-1)!.uuid,sessionId,
  timestamp:'2026-09-25T00:00:01Z',attachment:{type:'goal_status',condition:'finish fixture',...terminal}})
 return messages
}

test('both actual SDK loaders retain trailing pending and terminal goal markers',async()=>{
 setIsInteractive(false)
 await withTempDir(async cwd=>{
  for(const terminal of [undefined,{met:true},{met:true,sentinel:true},{met:false,failed:true}]){
   const id=randomUUID(), entries=transcript(id,terminal)
   createSessionJsonl(cwd,id,entries)
   const session=await unstable_v2_resumeSession(id,{cwd})
   try {
    const state=(session as any).appStateStore.getState()
    expect(session.getMessages().map(m=>(m as any).uuid)).toEqual(entries.map(m=>m.uuid))
    expect(state.activeGoal?.condition).toBe(terminal?undefined:'finish fixture')
    expect(getGoalHooks(state,id)).toHaveLength(terminal?0:1)
   }finally{session.close()}
   const q=query({prompt:'fixture',options:{cwd,resume:id}}),engine=new MockQueryEngine()
   ;(q as any).setEngine(engine)
   try{
    await collectMessages(q)
    expect(engine.getMessages().map(m=>(m as any).uuid)).toEqual(entries.map(m=>m.uuid))
    const state=(q as any).appStateStore.getState()
    expect(state.activeGoal?.condition).toBe(terminal?undefined:'finish fixture')
    expect(getGoalHooks(state,id)).toHaveLength(terminal?0:1)
   }finally{q.close()}
  }
 })
})

test('resumeSessionAt does not restore goal changes after the selected historical message',async()=>{
 setIsInteractive(false)
 await withTempDir(async cwd=>{
  const id=randomUUID(),entries=transcript(id)
  createSessionJsonl(cwd,id,entries)
  const q=query({prompt:'fixture',options:{cwd,resume:id,resumeSessionAt:entries[1]!.uuid as string}}),engine=new MockQueryEngine()
  ;(q as any).setEngine(engine)
  try{
   await collectMessages(q)
   expect(engine.getMessages()).toHaveLength(2)
   expect((q as any).appStateStore.getState().activeGoal).toBeUndefined()
  }finally{q.close()}
 })
})

test('concurrent resumed SDK sessions bind hooks to their own session IDs',async()=>{
 setIsInteractive(false)
 await withTempDir(async cwd=>{
  const a=randomUUID(),b=randomUUID()
  createSessionJsonl(cwd,a,transcript(a));createSessionJsonl(cwd,b,transcript(b,{met:true}))
  const [one,two]=await Promise.all([unstable_v2_resumeSession(a,{cwd}),unstable_v2_resumeSession(b,{cwd})])
  try{
   expect(getGoalHooks((one as any).appStateStore.getState(),a)).toHaveLength(1)
   expect(getGoalHooks((one as any).appStateStore.getState(),b)).toHaveLength(0)
   expect((two as any).appStateStore.getState().activeGoal).toBeUndefined()
   expect(runWithSdkContext({sessionId:a as any,cwd,originalCwd:cwd},()=>getSessionId())).toBe(a)
  }finally{one.close();two.close()}
 })
})
