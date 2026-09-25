import {afterAll,expect,mock,test} from 'bun:test'
import {getEmptyToolPermissionContext,type ToolUseContext} from '../../Tool.js'
import type {QueryParams} from '../../query.js'
import {createFileStateCacheWithSizeLimit} from '../../utils/fileStateCache.js'
import {getAgentContext} from '../../utils/agentContext.js'
import {readWorkflowPermissionContext,type WorkflowPermissionOwner} from './permissionLayers.ts'

const queryModule=await import('../../query.js'),storage=await import('../../utils/sessionStorage.js')
const hooks=await import('../../utils/hooks.js'),settings=await import('../../utils/settings/settings.js')
const toolModule=await import('../../tools.js')
const captured:Array<{params:QueryParams;identity:ReturnType<typeof getAgentContext>}>=[]
mock.module('../../query.js',()=>({...queryModule,query:async function*(params:QueryParams){
  captured.push({params,identity:getAgentContext()})
  if(params.toolUseContext.options.requiresStructuredOutput)yield {type:'attachment',attachment:{type:'structured_output',data:{answer:42}}}
  yield {type:'assistant',uuid:'00000000-0000-0000-0000-000000000042',timestamp:new Date().toISOString(),
    message:{id:'test-response',role:'assistant',type:'message',model:params.toolUseContext.options.mainLoopModel,
      content:[{type:'text',text:'42'}],stop_reason:'end_turn',usage:{input_tokens:30,output_tokens:12}}}
}}))
mock.module('../../utils/sessionStorage.js',()=>({...storage,recordSidechainTranscript:async()=>{},writeAgentMetadata:async()=>{}}))
mock.module('../../utils/hooks.js',()=>({...hooks,executeSubagentStartHooks:async function*(){}}))
mock.module('../../utils/settings/settings.js',()=>({...settings,getInitialSettings:()=>({})}))
mock.module('../../tools.js',()=>({...toolModule,assembleToolPool:()=>[]}))
const {createWorkflowLocalAgent}=await import('./localAgent.js')
afterAll(()=>mock.restore())
function fixture(mode='default') {
  let state:any={toolPermissionContext:{...getEmptyToolPermissionContext(),mode},todos:{},tasks:{},mcp:{tools:[]}}
  const parent:ToolUseContext={options:{mainLoopModel:'claude-sonnet-4-6',tools:[],commands:[],thinkingConfig:{type:'disabled'},mcpClients:[],mcpResources:{},
    agentDefinitions:{activeAgents:[]},spawnedBySkill:'review'},abortController:new AbortController(),readFileState:createFileStateCacheWithSizeLimit(),
    getAppState:()=>state,setAppState:update=>{state=update(state)},messages:[],agentContext:{agentType:'subagent',agentId:'parent',depth:1}} as unknown as ToolUseContext
  const controllers:Array<[string,AbortController|null]>=[],progress:unknown[]=[],failures:string[]=[],classified:unknown[]=[],permissionCalls:unknown[]=[]
  const canUseTool:Parameters<typeof createWorkflowLocalAgent>[0]['canUseTool']=async(...args)=>{permissionCalls.push(args);return {behavior:'deny',message:'fixture deny'}}
  const options:Parameters<typeof createWorkflowLocalAgent>[0]={parent,canUseTool,workflowRunId:'wf_test',workflowName:'review',
    readPermissionContext:context=>context.getAppState().toolPermissionContext,
    classifyDispatch:async input=>{classified.push(input);return null},onClassifierError:()=>{},onController:(id,c)=>controllers.push([id,c]),
    onProgress:event=>progress.push(event),recordFailure:failure=>failures.push(failure)}
  const request=(supplied?:Record<string,unknown>)=>({index:1,prompt:'return 42',label:'answer',stallMs:5000,options:supplied,queuedAt:Date.now(),onStarted:()=>{}})
  return {options,request,parent,state,controllers,progress,failures,classified,permissionCalls}
}
test('actual runAgent receives original permission callback, workflow identity and approved model',async()=>{
  const f=fixture(),execute=createWorkflowLocalAgent(f.options)
  expect(await execute(f.request())).toBe('42')
  const call=captured.at(-1)!
  expect(call.params.canUseTool).toBe(f.options.canUseTool)
  expect(call.params.toolUseContext.options.mainLoopModel).toBe(f.parent.options.mainLoopModel)
  expect(call.params.toolUseContext.spawnedByWorkflowRunId).toBe('wf_test')
  expect(call.params.toolUseContext.options.spawnedBySkill).toBe('review')
  expect(call.identity?.workflowName).toBe('review')
  expect(call.identity?.depth).toBe(2)
  expect(call.params.toolUseContext.isBackgroundAgent).toBe(true)
  expect(f.controllers.at(-1)?.[1]).toBe(null)
  expect(f.parent.abortController.signal.aborted).toBe(false)
})
test('structured schema is a real tool and its attachment passes through attempt/retry pipeline',async()=>{
  const f=fixture()
  expect(await createWorkflowLocalAgent(f.options)(f.request({schema:{type:'object',properties:{answer:{type:'number'}},required:['answer']}}))).toEqual({answer:42})
  const call=captured.at(-1)!
  expect(call.params.toolUseContext.options.requiresStructuredOutput).toBe(true)
  expect(call.params.toolUseContext.options.tools.some(tool=>tool.name==='StructuredOutput')).toBe(true)
  const count=captured.length
  await expect(createWorkflowLocalAgent(f.options)(f.request({schema:{type:'not-a-json-schema-type'}}))).rejects.toThrow('invalid JSON Schema')
  expect(captured.length).toBe(count)
})
test('classifier denial, oversized schema and denied agent types stop before inference',async()=>{
  const f=fixture('auto'),count=captured.length
  f.options.classifyDispatch=async()=>({reason:'blocked fixture'})
  expect(await createWorkflowLocalAgent(f.options)(f.request())).toBe(null)
  expect(f.failures[0]).toContain('blocked fixture')
  f.options.classifyDispatch=async()=>{throw Error('oversize must not reach classifier')}
  expect(await createWorkflowLocalAgent(f.options)(f.request({schema:{description:'x'.repeat(5000)}}))).toBe(null)
  expect(f.failures[1]).toContain('too large')
  expect(captured.length).toBe(count)
  const plain=fixture()
  await expect(createWorkflowLocalAgent(plain.options)(plain.request({agentType:'nonexistent'}))).rejects.toThrow('not found')
  plain.parent.options.agentDefinitions.activeAgents.push({agentType:'Explore',source:'built-in'} as never)
  plain.state.toolPermissionContext.alwaysDenyRules={userSettings:['Agent(Explore)']}
  await expect(createWorkflowLocalAgent(plain.options)(plain.request({agentType:'Explore'}))).rejects.toThrow('denied')
  expect(captured.length).toBe(count)
})
test('cancellation while dispatch is checked stops even if classifier returns allow',async()=>{
  const f=fixture('auto'),count=captured.length
  f.options.classifyDispatch=async()=>{f.parent.abortController.abort();return null}
  await expect(createWorkflowLocalAgent(f.options)(f.request())).rejects.toThrow('Workflow aborted')
  expect(captured.length).toBe(count)
})

test('effective invocation layers reach actual runAgent and parent revocations stay live',async()=>{
  const f=fixture()
  const owner=f.parent as ToolUseContext&WorkflowPermissionOwner
  owner.permissionLayers=[{kind:'disallowed_tools',disallowedTools:['Write']},{kind:'avoid_prompts'}]
  f.options.readPermissionContext=context=>readWorkflowPermissionContext(context as WorkflowPermissionOwner,{isBypassBlocked:()=>true})
  expect(await createWorkflowLocalAgent(f.options)(f.request())).toBe('42')
  const child=captured.at(-1)!.params.toolUseContext
  expect(child.getAppState().toolPermissionContext.alwaysDenyRules.command).toEqual(['Write'])
  expect(child.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts).toBe(true)
  expect(f.state.toolPermissionContext.alwaysDenyRules.command).toBeUndefined()
  f.state.toolPermissionContext={...f.state.toolPermissionContext,alwaysDenyRules:{policySettings:['Read']}}
  expect(child.getAppState().toolPermissionContext.alwaysDenyRules.policySettings).toEqual(['Read'])
  expect(child.getAppState().toolPermissionContext.alwaysDenyRules.command).toEqual(['Write'])
  expect(captured.at(-1)!.params.canUseTool).toBe(f.options.canUseTool)
})
