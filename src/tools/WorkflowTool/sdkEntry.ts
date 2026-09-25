import {randomUUID} from 'node:crypto'
import {dirname,join} from 'node:path'
import {z} from 'zod/v4'
import {buildTool,type ToolUseContext} from '../../Tool.js'
import type {CanUseToolFn} from '../../hooks/useCanUseTool.js'
import {getSessionId} from '../../bootstrap/state.js'
import {getTranscriptPath} from '../../utils/sessionStorage.js'
import {createAssistantMessage} from '../../utils/messages.js'
import {getRuleByContentsForToolName} from '../../utils/permissions/permissions.js'
import {classifyYoloAction,formatActionForClassifier} from '../../utils/permissions/yoloClassifier.js'
import {getBundledWorkflows} from './bundled/index.js'
import {WorkflowRegistry} from './registry.js'
import {checkWorkflowPermission} from './permissionDecision.js'
import {createWorkflowRun} from './durableJournal.js'
import {compileWorkflowScript} from './compiler.js'
import {launchWorkflowRun} from './runtime.js'
import type {WorkflowProgressEvent} from './agentDispatcher.js'
import type {WorkflowAgentMessage} from './agentAttempt.js'

export type BundledWorkflowOptions = {
  name:'code-review'|'deep-research'
  args:string
  resumeFromRunId?:string
  timeoutMs?:number
  maxOutputTokens?:number
  /** Trusted SDK host observers. Child transcript data is never auto-published. */
  onProgress?:(event:WorkflowProgressEvent)=>void
  onAgentMessage?:(agent:{index:number;label:string;agentId:string},event:WorkflowAgentMessage)=>void
  onStarted?:(runId:string,taskId:string)=>void
}

// Explicit SDK invocation still traverses the same permission owner as tools.
// This object is not registered for implicit model invocation.
const registry=new WorkflowRegistry({builtins:getBundledWorkflows({deepResearchEnabled:true}),bundledOnly:()=>true})
const inputSchema=z.object({name:z.enum(['code-review','deep-research']),args:z.string()})
const permissionTool=buildTool({
  name:'Workflow', renderToolUseMessage:()=>null, inputSchema, maxResultSizeChars:100000,
  description:async()=> 'Run an approved bundled workflow',prompt:async()=> 'Run an approved bundled workflow',
  toAutoClassifierInput:input=>input,
  checkPermissions:async(input,context)=>checkWorkflowPermission(input,{
    readPermissionContext:()=>context.getAppState().toolPermissionContext,getRules:getRuleByContentsForToolName,
    readScriptPath:async()=>({error:'SDK entry accepts bundled names only'}),
    resolveNamed:async name=>registry.resolve({name},process.cwd()),
  }),
  call:async()=>{throw Error('Use the explicit SDK bundled workflow entry')},
  mapToolResultToToolResultBlockParam:(data,id)=>({type:'tool_result',tool_use_id:id,content:JSON.stringify(data)}),
})

export async function startBundledWorkflow(options:BundledWorkflowOptions,parent:ToolUseContext,canUseTool:CanUseToolFn) {
  const input=inputSchema.parse({name:options.name,args:options.args})
  if(!input.args.trim())throw Error('Workflow requires a question or review target')
  if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<=0))throw Error('Invalid workflow timeout')
  if(options.maxOutputTokens!==undefined&&(!Number.isSafeInteger(options.maxOutputTokens)||options.maxOutputTokens<=0))throw Error('Invalid workflow token budget')
  parent.abortController.signal.throwIfAborted()
  const approved=await registry.resolve({name:input.name},process.cwd())
  const toolUseId=randomUUID()
  const invocation=createAssistantMessage({content:[{type:'tool_use',id:toolUseId,name:'Workflow',input}]})
  const decision=await canUseTool(permissionTool,input,parent,invocation,toolUseId)
  if(decision.behavior!=='allow')throw Error('Workflow permission denied')
  // Approval cannot swap reviewed builtin bytes or inject another script.
  if(decision.updatedInput && (decision.updatedInput.name!==input.name || decision.updatedInput.args!==input.args))throw Error('Workflow approval changed the invocation; resubmit for review')
  parent.abortController.signal.throwIfAborted()
  const compiled=compileWorkflowScript(approved.scriptBody)
  if(!compiled.ok)throw Error(compiled.error)
  const runId=randomUUID(),taskId='workflow_'+runId
  const lease=await createWorkflowRun({rootDirectory:join(dirname(getTranscriptPath()),getSessionId(),'workflow-runs'),runId,
    owner:{sessionId:getSessionId(),agentId:parent.agentId??'main'},approved,args:input.args,resumeFromRunId:options.resumeFromRunId})
  const run=launchWorkflowRun({taskId,lease,vmScript:compiled.vmScript,parent,canUseTool,registry,toolUseId,
    maxOutputTokens:options.maxOutputTokens,restrictToParentTools:true,suppressCompletionNotification:true,
    onProgress:options.onProgress,onAgentMessage:options.onAgentMessage,
    readPermissionContext:context=>context.getAppState().toolPermissionContext,
    classifyDispatch:async request=>{
      const result=await classifyYoloAction(request.parent.messages,formatActionForClassifier('Agent',{
        prompt:request.prompt,subagent_type:request.agentType??'workflow-subagent',schema:request.schemaJson}),
        request.parent.options.tools,request.permissions,request.parent.abortController.signal).catch(()=>({unavailable:true,shouldBlock:true,reason:'Classifier unavailable'}))
      return result.unavailable||result.shouldBlock?{reason:result.reason??'Classifier unavailable'}:null
    },onError:()=>{},
  })
  const abort=()=>run.task.abortController!.abort(parent.abortController.signal.reason)
  parent.abortController.signal.addEventListener('abort',abort,{once:true})
  if(parent.abortController.signal.aborted)abort()
  let timedOut=false
  const timer=options.timeoutMs===undefined?undefined:setTimeout(()=>{
    timedOut=true
    run.task.abortController!.abort(new Error('Workflow timed out'))
  },options.timeoutMs)
  try {options.onStarted?.(runId,taskId)} catch(error){run.task.abortController!.abort(error)}
  const completion=run.completion.then(result=>timedOut?{...result,result:null,error:'Workflow timed out'}:result)
    .finally(()=>{if(timer)clearTimeout(timer);parent.abortController.signal.removeEventListener('abort',abort)})
  return {...run,runId,completion}
}
