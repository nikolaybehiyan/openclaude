import {afterAll,expect,mock,test} from 'bun:test'
import {getSessionId,setCostStateForRestore,switchSession} from '../bootstrap/state.js'
import {getDefaultAppState} from '../state/AppStateStore.js'
import type {SessionId} from '../types/ids.js'
const costs=await import('../cost-tracker.js')
const storage=await import('./sessionStorage.js')
const recording=await import('./asciicast.js')
const sessions=await import('./concurrentSessions.js')
const hooks=await import('./hooks.js')
const policy=await import('./hooks/hooksConfigSnapshot.js')
const calls:string[]=[]
mock.module('../cost-tracker.js',()=>({...costs,restoreCostStateForSession:(id:string)=>{
 calls.push('cost:'+id);expect(String(getSessionId())).toBe(id)
 setCostStateForRestore({totalCostUSD:0,totalAPIDuration:0,totalAPIDurationWithoutRetries:0,totalToolDuration:0,totalLinesAdded:0,totalLinesRemoved:0,lastDuration:undefined,modelUsage:{fixture:{inputTokens:0,outputTokens:345,cacheReadInputTokens:0,cacheCreationInputTokens:0,webSearchRequests:0,costUSD:0,contextWindow:200000,maxOutputTokens:1000}}})
 return true
}}))
mock.module('./sessionStorage.js',()=>({...storage,resetSessionFilePointer:async()=>{},restoreSessionMetadata:()=>{},adoptResumedSessionFile:()=>{},saveMode:()=>{}}))
mock.module('./asciicast.js',()=>({...recording,renameRecordingForSession:async()=>{}}))
mock.module('./concurrentSessions.js',()=>({...sessions,updateSessionName:async()=>{}}))
mock.module('./hooks.js',()=>({...hooks,shouldSkipHookDueToTrust:()=>false}))
mock.module('./hooks/hooksConfigSnapshot.js',()=>({...policy,shouldDisableAllHooksIncludingManaged:()=>false,shouldAllowManagedHooksOnly:()=>false}))
const {processResumedConversation}=await import('./sessionRestore.js')
const {getGoalHooks}=await import('./goal.js')
afterAll(()=>mock.restore())
test('actual CLI resume changes session and restores cost before binding the pending goal',async()=>{
 const old='12345678-1234-1234-1234-123456789001' as SessionId
 const target='12345678-1234-1234-1234-123456789002' as const
 switchSession(old,null)
 const initialState=getDefaultAppState()
 const result=await processResumedConversation({sessionId:target,messages:[{type:'attachment',uuid:'12345678-1234-1234-1234-123456789003',timestamp:new Date().toISOString(),attachment:{type:'goal_status',met:false,sentinel:true,condition:'resumed goal'}}]},
  {forkSession:false},{modeApi:null,mainThreadAgentDefinition:undefined,agentDefinitions:{allAgents:[],activeAgents:[]},currentCwd:process.cwd(),cliAgents:[],initialState})
 expect(calls).toEqual(['cost:'+target])
 expect(String(getSessionId())).toBe(target)
 expect(result.initialState.activeGoal).toMatchObject({condition:'resumed goal',iterations:0,tokensAtStart:345})
 expect(getGoalHooks(result.initialState,target)).toEqual([{type:'prompt',prompt:'resumed goal'}])
 expect(getGoalHooks(result.initialState,old)).toEqual([])
})
