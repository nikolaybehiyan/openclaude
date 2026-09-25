import {afterEach,expect,test} from 'bun:test'
import {getIsInteractive,getIsNonInteractiveSession,runWithSdkContext,setIsInteractive} from './state.js'
import {getCommands} from '../commands.js'
import {goalUnavailableReason} from '../utils/goal.js'
afterEach(()=>setIsInteractive(true))
test('SDK goal command and implicit hook trust are scoped without changing interactive clients',async()=>{
 setIsInteractive(true)
 expect(getIsInteractive()).toBe(true)
 await runWithSdkContext({sessionId:crypto.randomUUID() as any,sessionProjectDir:null,cwd:'/tmp',originalCwd:'/tmp'},async()=>{
  expect(getIsNonInteractiveSession()).toBe(true)
  expect(getIsInteractive()).toBe(false)
  const goal=(await getCommands('/tmp')).filter(command=>command.name==='goal')
  expect(goal).toHaveLength(1)
  expect(goal[0]?.type).toBe('local')
  expect(goalUnavailableReason()).toBeNull()
 })
 expect(getIsInteractive()).toBe(true)
})
