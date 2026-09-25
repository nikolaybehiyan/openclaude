import type {Script} from 'node:vm'
import type {CanUseToolFn} from '../../hooks/useCanUseTool.js'
import type {ToolUseContext} from '../../Tool.js'
import {getCurrentTurnTokenBudget,getTotalOutputTokens,getTurnOutputTokens} from '../../bootstrap/state.js'
import {getCwd} from '../../utils/cwd.js'
import {emitTaskProgress} from '../../utils/task/sdkProgress.js'
import {completeWorkflowTask,createWorkflowProgressBatcher,enqueueWorkflowNotification,failWorkflowTask,isLocalWorkflowTask,
  registerWorkflowTask,updateWorkflowProgressBatch} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type {LocalWorkflowTaskState,WorkflowProgress,SdkWorkflowProgress} from '../../tasks/LocalWorkflowTask/types.js'
import {createWorkflowAgentDispatcher} from './agentDispatcher.ts'
import {createWorkflowLocalAgent,type WorkflowLocalAgentOptions} from './localAgent.ts'
import {createChildWorkflowResolver} from './childWorkflow.ts'
import type {WorkflowRunLease} from './durableJournal.ts'
import {WorkflowRegistry} from './registry.ts'
import {executeWorkflowVM,type WorkflowVMResult} from './vmRunner.ts'
import type {WorkflowVMBridge,WorkflowVMFunction} from './vmBoundary.ts'
import {workflowHostError} from './hostBoundary.ts'

/** IRn lifecycle over the existing AppState/SDK transport. This owns an
 * already-approved, exclusively leased run. A caller must not close the lease
 * or reuse this run ID while completion is pending. */
export function launchWorkflowRun(options:{
  taskId:string
  lease:WorkflowRunLease
  vmScript:Script
  parent:ToolUseContext
  canUseTool:CanUseToolFn
  registry:WorkflowRegistry
  invokingRequestId?:string
  toolUseId?:string
  suppressCompletionNotification?:boolean
  readPermissionContext:WorkflowLocalAgentOptions['readPermissionContext']
  classifyDispatch:WorkflowLocalAgentOptions['classifyDispatch']
  onError:(error:unknown)=>void
  onProgress?:WorkflowLocalAgentOptions['onProgress']
  onAgentMessage?:WorkflowLocalAgentOptions['onAgentMessage']
  restrictToParentTools?:boolean
  maxOutputTokens?:number
}):{task:LocalWorkflowTaskState;completion:Promise<WorkflowVMResult>} {
  const {lease,parent}=options,meta=lease.approved.meta
  const setAppState=parent.setAppStateForTasks??parent.setAppState
  let task:LocalWorkflowTaskState
  try {
    task=registerWorkflowTask({taskId:options.taskId,script:lease.approved.script,scriptPath:lease.scriptPath,args:lease.args,
      workflowRunId:lease.runId,workflowName:meta.name,summary:meta.description,title:meta.title,phases:meta.phases,
      defaultModel:parent.options.mainLoopModel,ownerAgentId:parent.agentId,setAppState,toolUseId:options.toolUseId})
  } catch(error) {
    // No child has started; rejected registration must not strand its lease.
    void lease.close().catch(options.onError)
    throw error
  }
  const controller=task.abortController!,context={...parent,abortController:controller}
  const outputAtStart=getTotalOutputTokens()-getTurnOutputTokens()
  const limits=[getCurrentTurnTokenBudget(),options.maxOutputTokens].filter((v):v is number=>v!=null)
  const budget={total:limits.length?Math.min(...limits):null,getTurnSpent:()=>getTotalOutputTokens()-outputAtStart}
  const pending=new Set<Promise<unknown>>()
  let lastSdkSnapshot=0
  const batcher=createWorkflowProgressBatcher({
    isNonInteractive:()=>parent.options.isNonInteractiveSession,isBackground:()=>Boolean(parent.isBackgroundAgent),
    onBatch:batch=>updateWorkflowProgressBatch(task.id,batch,setAppState),
    onSdkEmit:batch=>{
      const visible=batch.filter((item):item is SdkWorkflowProgress=>item.type!=='workflow_log')
      const state=parent.getAppState().tasks[task.id]
      if(!visible.length || !isLocalWorkflowTask(state) || state.status!=='running')return
      const last=visible.findLast(item=>item.type==='workflow_agent')
      const now=Date.now(),full=!visible.every(item=>item.type==='workflow_agent' && item.state==='progress')||now-lastSdkSnapshot>=1000
      if(full)lastSdkSnapshot=now
      emitTaskProgress({taskId:task.id,toolUseId:options.toolUseId,description:last?(last.phaseTitle?`${last.phaseTitle}: ${last.label}`:last.label):task.description,
        startTime:task.startTime,totalTokens:state.totalTokens,toolUses:state.totalToolCalls,lastToolName:last?.label,summary:meta.description,
        workflowProgress:full?state.workflowProgress.filter((item):item is SdkWorkflowProgress=>item.type!=='workflow_log'):undefined})
    },
  })
  const progress:WorkflowLocalAgentOptions['onProgress']=event=>{batcher.onProgress(event.data as WorkflowProgress);options.onProgress?.(event)}
  let bridge:WorkflowVMBridge,child:WorkflowVMFunction
  let hooks:ReturnType<typeof createWorkflowAgentDispatcher>|undefined
  const executor=createWorkflowLocalAgent({parent:context,canUseTool:options.canUseTool,workflowRunId:lease.runId,workflowName:meta.name,
    invokingRequestId:options.invokingRequestId,onAgentMessage:options.onAgentMessage,restrictToParentTools:options.restrictToParentTools,readPermissionContext:options.readPermissionContext,classifyDispatch:options.classifyDispatch,
    onClassifierError:options.onError,onProgress:progress,recordFailure:message=>hooks!.recordFailure(message),
    onController:(agentId,childController)=>{
      if(childController) {
        task.agentControllers?.set(agentId,childController)
        if(controller.signal.aborted)childController.abort(controller.signal.reason)
      } else task.agentControllers?.delete(agentId)
    },
  })
  function settle(result:WorkflowVMResult) {
    batcher.flushNow()
    const state=parent.getAppState().tasks[task.id]
    // Pause/kill/external cancellation already own their terminal transition.
    // Late stream completion cannot turn those into a successful run.
    if(!isLocalWorkflowTask(state)||state.status!=='running')return
    const terminal={summary:result.error?`Dynamic workflow "${meta.description}" failed: ${result.error}`:`Dynamic workflow "${meta.description}" completed`,
      output_file:task.outputFile,usage:{total_tokens:state.totalTokens,tool_uses:state.totalToolCalls,duration_ms:result.durationMs}}
    const transitioned=result.error?failWorkflowTask(task.id,result.error,result.agentCount,result.logs,setAppState,terminal)
      :completeWorkflowTask(task.id,result.result,result.agentCount,result.logs,setAppState,terminal)
    if(!transitioned)return
    enqueueWorkflowNotification({taskId:task.id,setAppState,summary:meta.description,status:result.error?'failed':'completed',result:result.result,
      error:result.error,failures:result.failures,agentCount:result.agentCount,totalTokens:state.totalTokens,totalToolCalls:state.totalToolCalls,
      durationMs:result.durationMs,toolUseId:options.toolUseId,scriptPath:lease.scriptPath,workflowRunId:lease.runId,args:lease.args,
      workflowProgress:state.workflowProgress,suppressCompletionNotification:options.suppressCompletionNotification})
  }
  const completion=(async():Promise<WorkflowVMResult>=>{
    let result:WorkflowVMResult
    try {
      const replay=await lease.journal.load()
      const dispatcher=createWorkflowAgentDispatcher({defaultModel:parent.options.mainLoopModel,signal:controller.signal,budget,
        seedPhaseTitles:meta.phases?.map(phase=>phase.title),journal:lease.journal,replay,onProgress:progress,onJournalError:options.onError,
        childWorkflow:(...args)=>child(...args),executeAgent:request=>{
          const operation=executor(request)
          pending.add(operation)
          operation.then(()=>pending.delete(operation),()=>pending.delete(operation))
          return operation
        }})
      hooks=dispatcher
      const bind=dispatcher.bindVMAwait
      dispatcher.bindVMAwait=value=>{bridge=value;bind(value)}
      child=createChildWorkflowResolver({registry:options.registry,cwd:getCwd,parentBridge:()=>bridge,hooks:dispatcher,signal:controller.signal,budget})
      // Both log() and console.* are formatted inside the VM boundary. Route
      // the resulting strings once, so console output also reaches live task
      // progress without duplicating log() events.
      result=await executeWorkflowVM(options.vmScript,{...dispatcher,log:()=>{}},{signal:controller.signal,args:lease.args,budget,
        onLog:message=>dispatcher.log(message)})
    }catch(error){
      options.onError(error)
      result={result:null,error:workflowHostError(error).message,agentCount:hooks?.getAgentCount()??0,logs:[],failures:hooks?.getFailures()??[],durationMs:Date.now()-task.startTime}
    }
    try {settle(result)} finally {
      // Abort even unawaited children, then wait for their real generators to
      // stop before the durable source/destination locks can be released.
      controller.abort()
      for(const childController of task.agentControllers?.values()??[])childController.abort()
      await Promise.allSettled([...pending])
      batcher.cancel()
      await lease.close()
    }
    return result
  })()
  void completion.catch(options.onError)
  return {task,completion}
}
