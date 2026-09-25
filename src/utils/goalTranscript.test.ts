import {expect,test} from 'bun:test'
import {withTrailingGoalStatuses} from './goalTranscript.js'
import {isLoggableMessage,buildConversationChain} from './sessionStorage.js'
import {findGoalToRestore} from './goal.js'
import type {Message} from '../types/message.js'
const user={uuid:'user',parentUuid:null,type:'user',timestamp:'2026-01-01T00:00:00Z'}
const set={uuid:'set',parentUuid:'user',type:'attachment',attachment:{type:'goal_status',condition:'finish',met:false,sentinel:true},timestamp:'2026-01-01T00:00:01Z'}
const assistant={uuid:'assistant',parentUuid:'set',type:'assistant',message:{id:'fixture-assistant',role:'assistant',content:[{type:'text',text:'fixture'}]},timestamp:'2026-01-01T00:00:02Z'}
test('goal markers persist for external users while unrelated attachments stay private',()=>{
 expect(isLoggableMessage(set as unknown as Message)).toBe(true)
 expect(isLoggableMessage({...set,attachment:{type:'directory',path:'/fixture'}} as unknown as Message)).toBe(false)
})
test('real conversation chain includes terminal goal statuses after its user/assistant leaf',()=>{
 for(const status of [{met:true},{met:true,sentinel:true},{met:false,failed:true},{met:false}]){
  const terminal={uuid:'terminal',parentUuid:'assistant',type:'attachment',attachment:{type:'goal_status',condition:'finish',...status},timestamp:'2026-01-01T00:00:03Z'}
  const map=new Map([user,set,assistant,terminal].map(entry=>[entry.uuid,entry]))
  const chain=buildConversationChain(map as any,assistant as any)
  expect(chain.map(entry=>entry.uuid)).toEqual(['user','set','assistant','terminal'])
  expect(findGoalToRestore(chain as unknown as Message[])).toBe(status.met||('failed' in status&&status.failed)?null:'finish')
 }
})
test('trailing recovery follows metadata but never crosses another conversation branch or cycles',()=>{
 const metadata={uuid:'meta',parentUuid:'assistant',type:'system'}
 const clear={uuid:'clear',parentUuid:'meta',type:'attachment',attachment:{type:'goal_status'},timestamp:'2026-01-01T00:00:03Z'}
 const next={uuid:'next',parentUuid:'assistant',type:'user'}
 const foreign={uuid:'foreign',parentUuid:'next',type:'attachment',attachment:{type:'goal_status'}}
 const map=new Map([user,set,assistant,metadata,clear,next,foreign].map(entry=>[entry.uuid,entry]))
 const chain=[user,set,assistant]
 expect(withTrailingGoalStatuses(map,chain).map(entry=>entry.uuid)).toEqual(['user','set','assistant','clear'])
 expect(chain).toHaveLength(3)
 map.set('assistant',{...assistant,parentUuid:'clear'})
 expect(withTrailingGoalStatuses(map,chain).map(entry=>entry.uuid)).toEqual(['user','set','assistant','clear'])
})
