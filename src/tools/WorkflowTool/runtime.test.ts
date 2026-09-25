import {afterAll,afterEach,beforeEach,expect,mock,test} from 'bun:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {getEmptyToolPermissionContext,type ToolUseContext} from '../../Tool.js'
import {generateTaskId} from '../../Task.js'
import type {QueryParams} from '../../query.js'
import {setCwdState,setIsInteractive} from '../../bootstrap/state.js'
import {createFileStateCacheWithSizeLimit} from '../../utils/fileStateCache.js'
import {clearCommandQueue,getCommandQueue} from '../../utils/messageQueueManager.js'
import {_clearOutputsForTest,_resetTaskOutputDirForTest,getTaskOutputDir} from '../../utils/task/diskOutput.js'
import {killWorkflowTask,pauseWorkflowTask} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {WorkflowRegistry} from './registry.ts'
import {createWorkflowRun} from './durableJournal.ts'
import {compileWorkflowScript} from './compiler.ts'

const queryModule=await import('../../query.js'),storage=await import('../../utils/sessionStorage.js')
const hooks=await import('../../utils/hooks.js'),settings=await import('../../utils/settings/settings.js')
const toolModule=await import('../../tools.js')
let queryCalls=0
let queryBehavior:((params:QueryParams)=>AsyncGenerator<any>)|undefined
mock.module('../../query.js',()=>({...queryModule,query:async function*(params:QueryParams){
  queryCalls++
  if(queryBehavior){yield* queryBehavior(params);return}
  if(params.toolUseContext.options.requiresStructuredOutput)yield {type:'attachment',attachment:{type:'structured_output',data:{answer:42}}}
  yield {type:'assistant',uuid:'00000000-0000-0000-0000-000000000042',timestamp:new Date().toISOString(),
    message:{id:'test-response',role:'assistant',type:'message',model:params.toolUseContext.options.mainLoopModel,
      content:[{type:'text',text:'42'}],stop_reason:'end_turn',usage:{input_tokens:30,output_tokens:12}}}
}}))
mock.module('../../utils/sessionStorage.js',()=>({...storage,recordSidechainTranscript:async()=>{},writeAgentMetadata:async()=>{}}))
mock.module('../../utils/hooks.js',()=>({...hooks,executeSubagentStartHooks:async function*(){}}))
mock.module('../../utils/settings/settings.js',()=>({...settings,getInitialSettings:()=>({}),getSettings_DEPRECATED:()=>({})}))
mock.module('../../tools.js',()=>({...toolModule,assembleToolPool:()=>[]}))
const {launchWorkflowRun}=await import('./runtime.ts')
const root=await mkdtemp(join(tmpdir(),'workflow-runtime-'))
setCwdState(root);setIsInteractive(true);_resetTaskOutputDirForTest()
const outputDir=getTaskOutputDir()
const leases:Array<Awaited<ReturnType<typeof createWorkflowRun>>>=[]
beforeEach(()=>{queryBehavior=undefined;queryCalls=0;clearCommandQueue()})
afterEach(async()=>{await Promise.all(leases.splice(0).map(lease=>lease.close()));await _clearOutputsForTest();clearCommandQueue()})
afterAll(async()=>{mock.restore();await rm(root,{recursive:true,force:true});await rm(outputDir,{recursive:true,force:true})})

function fixture() {
  let state:any={toolPermissionContext:getEmptyToolPermissionContext(),todos:{},tasks:{},mcp:{tools:[]}}
  const parent:ToolUseContext={options:{mainLoopModel:'claude-sonnet-4-6',tools:[],commands:[],thinkingConfig:{type:'disabled'},mcpClients:[],mcpResources:{},
    isNonInteractiveSession:false,agentDefinitions:{activeAgents:[]}},abortController:new AbortController(),readFileState:createFileStateCacheWithSizeLimit(),
    getAppState:()=>state,setAppState:update=>{state=update(state)},messages:[]} as unknown as ToolUseContext
  const errors:unknown[]=[]
  const registry=new WorkflowRegistry({builtins:[{name:'child',description:'Child',source:'built-in',
    script:"export const meta={name:'child',description:'Child'};return await agent(args.prompt)"}]})
  async function lease(body:string,runId:string,resumeFromRunId?:string) {
    const approved=await registry.resolve({script:`export const meta={name:'root',description:'Root'};${body}`},root)
    const value=await createWorkflowRun({rootDirectory:root,owner:{sessionId:'runtime-test',agentId:'main'},approved,runId,resumeFromRunId})
    leases.push(value);return value
  }
  function launch(value:Awaited<ReturnType<typeof lease>>) {
    const compiled=compileWorkflowScript(value.approved.scriptBody)
    if(!compiled.ok)throw Error(compiled.error)
    return launchWorkflowRun({taskId:generateTaskId('local_workflow'),lease:value,vmScript:compiled.vmScript,parent,registry,
      canUseTool:async()=>({behavior:'deny',message:'test tool policy'}),
      readPermissionContext:context=>context.getAppState().toolPermissionContext,classifyDispatch:async()=>null,onError:error=>errors.push(error)})
  }
  return {parent,registry,errors,lease,launch,get state(){return state}}
}

test('actual runtime connects durable approval, VM, child workflow, runAgent and completion; resume replays without inference',async()=>{
  const f=fixture(),body='return [await agent("structured",{schema:{type:"object",properties:{answer:{type:"number"}},required:["answer"]}}),await workflow("child",{prompt:"plain"})]'
  const first=await f.lease(body,'runtime-first'),run=f.launch(first)
  expect((await run.completion).result).toEqual([{answer:42},'42'])
  await run.task.outputReady
  expect(queryCalls).toBe(2)
  expect(f.state.tasks[run.task.id].status).toBe('completed')
  expect(f.state.tasks[run.task.id].agentCount).toBe(2)
  expect(getCommandQueue().filter(command=>command.taskId===run.task.id)).toHaveLength(1)
  const resumed=await f.lease(body,'runtime-resumed','runtime-first'),next=f.launch(resumed)
  expect((await next.completion).result).toEqual([{answer:42},'42'])
  expect(queryCalls).toBe(2)
  expect(f.errors).toEqual([])
})

test('script failure closes the lease and publishes one failed result',async()=>{
  const f=fixture(),first=await f.lease('throw Error("runtime fixture failure")','runtime-error'),run=f.launch(first)
  expect((await run.completion).error).toContain('runtime fixture failure')
  expect(f.state.tasks[run.task.id].status).toBe('failed')
  expect(getCommandQueue().filter(command=>command.taskId===run.task.id)).toHaveLength(1)
  expect(queryCalls).toBe(0)
  const next=await f.lease('return 42','runtime-error-resume','runtime-error')
  await next.close()
})

test('script and console logs reach live state once without changing a falsy result',async()=>{
  const f=fixture(),first=await f.lease('log("one");console.log("two");return false','runtime-logs'),run=f.launch(first)
  const result=await run.completion
  expect(result.result).toBe(false)
  expect(result.logs).toEqual(['one','two'])
  expect(f.state.tasks[run.task.id].workflowProgress.filter((item:any)=>item.type==='workflow_log').map((item:any)=>item.message)).toEqual(['one','two'])
})

for(const action of ['kill','pause'] as const) test(`${action} retains its state and durable lease until the actual child generator stops`,async()=>{
  const f=fixture(),entered=Promise.withResolvers<void>(),aborted=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  queryBehavior=async function*(params){
    const signal=params.toolUseContext.abortController.signal
    entered.resolve()
    await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})})
    aborted.resolve();await release.promise;throw Error('fixture child stopped')
  }
  const id=`runtime-${action}`,first=await f.lease('return await agent("wait")',id),run=f.launch(first)
  await entered.promise
  if(action==='kill')killWorkflowTask(run.task.id,f.parent.setAppState)
  else pauseWorkflowTask(run.task.id,f.parent.setAppState)
  await aborted.promise
  let finished=false;void run.completion.then(()=>{finished=true})
  await expect(f.lease('return 42',`${id}-early`,id)).rejects.toThrow('active')
  expect(finished).toBe(false)
  release.resolve();await run.completion
  expect(f.state.tasks[run.task.id].status).toBe(action==='kill'?'killed':'paused')
  expect(getCommandQueue().filter(command=>command.taskId===run.task.id)).toHaveLength(0)
  const next=await f.lease('return 42',`${id}-later`,id);await next.close()
})
