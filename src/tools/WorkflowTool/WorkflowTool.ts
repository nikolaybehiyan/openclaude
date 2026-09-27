import {randomUUID} from 'node:crypto'
import {dirname,join} from 'node:path'
import {z} from 'zod/v4'
import {buildTool,type ToolUseContext} from '../../Tool.js'
import {generateTaskId} from '../../Task.js'
import {getSessionId} from '../../bootstrap/state.js'
import {getCwd} from '../../utils/cwd.js'
import {isEnvTruthy} from '../../utils/envUtils.js'
import {logError} from '../../utils/log.js'
import {getTranscriptPath} from '../../utils/sessionStorage.js'
import {getInitialSettings} from '../../utils/settings/settings.js'
import {getRuleByContentsForToolName} from '../../utils/permissions/permissions.js'
import {isBypassPermissionsModeDisabled} from '../../utils/permissions/permissionSetup.js'
import {classifyYoloAction,formatActionForClassifier} from '../../utils/permissions/yoloClassifier.js'
import {isWorkflowsEnabled} from '../../utils/workflows.js'
import {workflowSizePrompt} from '../../utils/workflowSize.js'
import {getWorkflowRegistry} from './discovery.js'
import {WORKFLOW_TOOL_NAME} from './constants.js'
import {compileWorkflowScript} from './compiler.js'
import {createWorkflowRun} from './durableJournal.js'
import {readWorkflowPermissionContext} from './permissionLayers.js'
import {checkWorkflowPermission} from './permissionDecision.js'
import {WORKFLOW_PROMPT} from './prompt.js'
import {WorkflowRegistry,readWorkflowScript,type WorkflowInput} from './registry.js'
import {launchWorkflowRun} from './runtime.js'
import {MAX_WORKFLOW_SCRIPT_LENGTH,parseWorkflowScript} from './scriptParser.js'
import {validateWorkflowInput} from './validation.js'

// Public tool contract ported from the pinned 2.1.226 DKb declaration.
// Registration is still owned by the build feature; importing this file grants
// neither workflow availability nor permission to execute a script.
// Child tool permissions remain owned by the ordinary CLI permission pipeline.
export const workflowInputSchema=z.strictObject({
  script:z.string().max(MAX_WORKFLOW_SCRIPT_LENGTH)
    .refine(value=>!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value),
      'script contains control characters that would be hidden in the approval dialog').optional()
    .describe('Self-contained JavaScript workflow. Begin with export const meta = {name, description, phases}; then orchestrate agent()/parallel()/pipeline()/phase().'),
  name:z.string().optional().describe('Name of a predefined workflow.'),
  description:z.string().optional().describe('Ignored; use meta.description.'),
  title:z.string().optional().describe('Ignored; use meta.title.'),
  args:z.unknown().optional().describe('Input exposed as args, verbatim. Pass actual JSON values, not JSON-encoded strings.'),
  scriptPath:z.string().optional().describe('Path of a workflow script; takes precedence over script and name. Edit the returned scriptPath and invoke again to iterate.'),
  resumeFromRunId:z.string().regex(/^wf_[a-z0-9-]{6,}$/).optional()
    .describe('Same-session completed or stopped workflow to resume. Stop the prior run before resuming.'),
}).refine(value=>Boolean(value.script||value.name||value.scriptPath),{message:'Must provide script, name, or scriptPath'})

export type WorkflowToolInput=z.infer<typeof workflowInputSchema>
export const workflowOutputSchema=z.object({
  status:z.literal('async_launched'),taskId:z.string(),taskType:z.literal('local_workflow'),workflowName:z.string(),
  runId:z.string(),summary:z.string(),transcriptDir:z.string().optional(),scriptPath:z.string().optional(),error:z.string().optional(),
})
export type WorkflowToolOutput=z.infer<typeof workflowOutputSchema>

export class WorkflowInputError extends Error {
  constructor(message:string){super(message);this.name='WorkflowInputError'}
}

export {getWorkflowRegistry} from './discovery.js'

function effectivePermissions(context:ToolUseContext) {
  return readWorkflowPermissionContext(context,{isBypassBlocked:isBypassPermissionsModeDisabled})
}

export function isWorkflowRetracted(signal:AbortSignal):boolean {
  const reason=signal.reason
  return signal.aborted&&(typeof reason==='string'?reason:reason instanceof Error?reason.message:undefined)==='server-fallback-tombstone'
}

async function resolveInput(input:WorkflowInput,registry:WorkflowRegistry):Promise<{script:string}|{error:string}> {
  // Resolution must not parse: malformed metadata belongs to validation code2,
  // not the missing-name/path code1. Approval subsequently freezes these bytes.
  try {
    if(input.scriptPath)return input.script?{script:input.script}:await readWorkflowScript(input.scriptPath,getCwd())
    if(input.name){const definition=(await registry.list()).find(item=>item.name===input.name)
      if(!definition)return{error:`Workflow "${input.name}" not found. Available: ${(await registry.list()).map(item=>item.name).join(', ')||'(none)'}`}
      return{script:input.script??definition.script}
    }
    return input.script?{script:input.script}:{error:'Must provide script, name, or scriptPath'}
  }catch(error){return{error:error instanceof Error?error.message:String(error)}}
}

export function workflowSummary(input:Partial<WorkflowToolInput>):string|null {
  if(input.name)return `dynamic workflow: ${input.name}`
  if(!input.script)return null
  const parsed=parseWorkflowScript(input.script)
  if(!('error'in parsed))return parsed.meta.description
  const first=input.script.split('\n').find(line=>line.trim())??''
  return first.length>50?first.slice(0,49)+'…':first
}

export function workflowResultBlock(data:WorkflowToolOutput,id:string) {
  if(data.error)return{type:'tool_result' as const,tool_use_id:id,is_error:true,
    content:`Workflow script has a syntax error and was not launched:\n${data.error}`}
  return{type:'tool_result' as const,tool_use_id:id,is_error:false,
    content:`Workflow launched in background. Task ID: ${data.taskId}\nSummary: ${data.summary}`+
      (data.transcriptDir?`\nTranscript dir: ${data.transcriptDir}`:'')+
      (data.scriptPath?`\nScript file: ${data.scriptPath}\nRun ID: ${data.runId}\nTo resume after editing: Workflow({scriptPath: ${JSON.stringify(data.scriptPath)}, resumeFromRunId: ${JSON.stringify(data.runId)}}). Completed agents return cached results; inspect journal.jsonl before assuming cached results are non-empty.`:'')+
      '\n\nYou will be notified when it completes. Use /workflows to watch live progress.'}
}

export const WorkflowTool=buildTool({
  name:WORKFLOW_TOOL_NAME,aliases:['RunWorkflow'],
  searchHint:'orchestrate subagents with deterministic JavaScript workflow',
  inputSchema:workflowInputSchema,outputSchema:workflowOutputSchema,maxResultSizeChars:100000,
  isEnabled:isWorkflowsEnabled,
  description:async()=>WORKFLOW_PROMPT+workflowSizePrompt(),prompt:async()=>WORKFLOW_PROMPT+workflowSizePrompt(),
  userFacingName:()=> 'Workflow',getToolUseSummary:workflowSummary,
  toAutoClassifierInput:(input:WorkflowToolInput)=>input.script||input.scriptPath||input.name||'',
  async validateInput(input:WorkflowToolInput,context:ToolUseContext){
    const registry=getWorkflowRegistry()
    return validateWorkflowInput(input,{
      isRetracted:()=>isWorkflowRetracted(context.abortController.signal),
      isDisabledByManagedSettings:()=>getInitialSettings().disableWorkflows===true,
      isEnabled:isWorkflowsEnabled,isNameOnly:()=>isEnvTruthy(process.env.CLAUDE_WORKFLOW_NAME_ONLY),
      resolveInput:value=>resolveInput(value,registry),recordNamedResolution:()=>{},
      readTasks:()=>context.getAppState().tasks,
    })
  },
  async checkPermissions(input:WorkflowToolInput,context:ToolUseContext){
    const registry=getWorkflowRegistry()
    return checkWorkflowPermission(input,{
      readPermissionContext:()=>effectivePermissions(context),getRules:getRuleByContentsForToolName,
      readScriptPath:async path=>{try{return await readWorkflowScript(path,getCwd())}catch(error){return{error:String(error)}}},
      resolveNamed:async name=>(await registry.list()).find(item=>item.name===name),
    })
  },
  renderToolUseMessage:(input:WorkflowToolInput,{verbose}:{verbose:boolean})=>input.name?`dynamic workflow: ${input.name}`:verbose?input.script??null:workflowSummary(input),
  mapToolResultToToolResultBlockParam:workflowResultBlock,
  async call(input:WorkflowToolInput,context:ToolUseContext,canUseTool,parentMessage){
    context.abortController.signal.throwIfAborted()
    // Recheck availability after asynchronous approval. A revoked policy must
    // not launch children merely because the old UI approved the operation.
    if(!isWorkflowsEnabled())throw new WorkflowInputError('Dynamic workflows are not enabled for this session')
    const registry=getWorkflowRegistry()
    let approved
    try{approved=await registry.resolve(input,getCwd())}catch(error){throw new WorkflowInputError(error instanceof Error?error.message:String(error))}
    const runId='wf_'+randomUUID().slice(0,12),taskId=generateTaskId('local_workflow')
    const base:WorkflowToolOutput={status:'async_launched',taskId,taskType:'local_workflow',workflowName:approved.meta.name,
      runId,summary:approved.meta.description}
    const compiled=compileWorkflowScript(approved.scriptBody)
    if(!compiled.ok)return{data:{...base,error:compiled.error}}
    const rootDirectory=join(dirname(getTranscriptPath()),getSessionId(),'workflow-runs')
    const lease=await createWorkflowRun({rootDirectory,runId,owner:{sessionId:getSessionId(),agentId:context.agentId??'main'},
      approved,args:input.args,resumeFromRunId:input.resumeFromRunId})
    try{context.abortController.signal.throwIfAborted()}catch(error){await lease.close();throw error}
    const run=launchWorkflowRun({taskId,lease,vmScript:compiled.vmScript,parent:context,canUseTool,registry,
      toolUseId:context.toolUseId,invokingRequestId:parentMessage?.requestId,
      readPermissionContext:effectivePermissions,
      classifyDispatch:async request=>{
        const result=await classifyYoloAction(request.parent.messages,formatActionForClassifier('Agent',{
          prompt:request.prompt,subagent_type:request.agentType??'workflow-subagent',schema:request.schemaJson}),
          request.parent.options.tools,request.permissions,request.parent.abortController.signal)
          .catch(()=>({unavailable:true,shouldBlock:true,reason:'Classifier unavailable'}))
        return result.unavailable||result.shouldBlock?{reason:result.reason??'Classifier unavailable'}:null
      },onError:logError,
    })
    void run.completion.catch(logError)
    return{data:{...base,transcriptDir:join(rootDirectory,runId),scriptPath:lease.scriptPath}}
  },
})
