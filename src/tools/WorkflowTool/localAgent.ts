import type {ToolPermissionContext, ToolUseContext, Tools} from '../../Tool.js'
import {toolMatchesName} from '../../Tool.js'
import type {CanUseToolFn} from '../../hooks/useCanUseTool.js'
import {getSessionId} from '../../bootstrap/state.js'
import {assembleToolPool} from '../../tools.js'
import {runWithAgentContext, type SubagentContext} from '../../utils/agentContext.js'
import {getCwd, runWithCwdOverride} from '../../utils/cwd.js'
import {parseEffortValue} from '../../utils/effort.js'
import {createUserMessage} from '../../utils/messages.js'
import {getAgentModel} from '../../utils/model/agent.js'
import {getCanonicalName} from '../../utils/model/model.js'
import {filterDeniedAgents, getDenyRuleForAgent} from '../../utils/permissions/permissions.js'
import {getQuerySourceForAgent} from '../../utils/promptCategory.js'
import {sleep} from '../../utils/sleep.js'
import {getTokenCountFromUsage} from '../../utils/tokens.js'
import {createAgentId} from '../../utils/uuid.js'
import {createAgentWorktree, hasWorktreeChanges, removeAgentWorktree} from '../../utils/worktree.js'
import {classifyHandoffIfNeeded} from '../AgentTool/agentToolUtils.js'
import {AGENT_TOOL_NAME} from '../AgentTool/constants.js'
import {isBuiltInAgent, type AgentDefinition, type BuiltInAgentDefinition} from '../AgentTool/loadAgentsDir.js'
import {runAgent} from '../AgentTool/runAgent.js'
import {createSyntheticOutputTool, SYNTHETIC_OUTPUT_TOOL_NAME} from '../SyntheticOutputTool/SyntheticOutputTool.js'
import type {WorkflowAgentRequest, WorkflowProgressEvent} from './agentDispatcher.ts'
import {runWorkflowAgentAttempt, workflowResultPreview, type WorkflowAgentMessage} from './agentAttempt.ts'
import {finishWorkflowAgent} from './agentExecution.ts'

const TEXT_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
- Be concise. The script will parse your output.`
const STRUCTURED_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: You MUST call the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call ${SYNTHETIC_OUTPUT_TOOL_NAME} with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool call.
- If the schema validation fails, read the error and call ${SYNTHETIC_OUTPUT_TOOL_NAME} again with a corrected shape.
- After calling ${SYNTHETIC_OUTPUT_TOOL_NAME} successfully, end your turn. No acknowledgment needed.`
const TEXT_SUFFIX = '\n\n---\n\nNOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.'
const STRUCTURED_SUFFIX = `\n\n---\n\nNOTE: You are running inside a workflow script. You MUST return your final answer by calling the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool exactly once — the tool's input schema defines the required shape. Do your work, then call ${SYNTHETIC_OUTPUT_TOOL_NAME}; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call ${SYNTHETIC_OUTPUT_TOOL_NAME} again with a corrected shape.`
// Include legacy local aliases until the canonical Workflow tool-name migration
// is qualified. None may reintroduce agent recursion through an alias.
const DISALLOWED = ['SendUserMessage',AGENT_TOOL_NAME,'Workflow','RunWorkflow','WorkflowTool']
const DEFAULT_AGENT: BuiltInAgentDefinition = {agentType:'workflow-subagent',whenToUse:'Internal subagent for workflow script orchestration.',
  tools:['*'],disallowedTools:DISALLOWED,source:'built-in',baseDir:'built-in',getSystemPrompt:()=>TEXT_PROMPT}

export type WorkflowDispatchCheck = {
  prompt: string
  schemaJson?: string
  agentType?: string
  parent: ToolUseContext
  permissions: ToolPermissionContext
}
export type WorkflowLocalAgentOptions = {
  parent: ToolUseContext
  canUseTool: CanUseToolFn
  workflowRunId: string
  workflowName?: string
  invokingRequestId?: string
  // These are mandatory host policy adapters. There is no permissive default:
  // the 226 effective permission layers/classifier must be wired by the tool.
  readPermissionContext(parent:ToolUseContext): ToolPermissionContext
  classifyDispatch(input:WorkflowDispatchCheck): Promise<{reason:string}|null>
  onClassifierError(error:unknown): void
  onController(agentId:string,controller:AbortController|null): void
  onProgress(progress:WorkflowProgressEvent): void
  recordFailure(message:string): void
  maxStructuredOutputRetries?: number
}
function schemaForClassification(schema:unknown): {json?:string;error?:string} {
  if (schema == null) return {}
  const seen = new WeakSet<object>()
  try {
    const json = JSON.stringify(schema,(_key,value)=>{
      if(typeof value==='bigint')return value.toString()
      if(value && typeof value==='object'){if(seen.has(value))return '[Circular]';seen.add(value)}
      return value
    })
    return json!==undefined && json.length>4096 ? {error:'output schema too large to classify safely'} : {json:json||undefined}
  } catch {return {error:'output schema could not be serialized for classification'}}
}
function summary(input:unknown):string|undefined {
  if(!input || typeof input!=='object')return undefined
  const fields=input as Record<string,unknown>
  for(const key of ['command','file_path','path','pattern','query','prompt']) if(typeof fields[key]==='string')return fields[key].replace(/\s+/g,' ').trim().slice(0,60)
  for(const value of Object.values(fields))if(typeof value==='string')return value.replace(/\s+/g,' ').trim().slice(0,60)
  return undefined
}

/** ZNp.Y → actual runAgent, preserving caller CanUseTool on every attempt. */
export function createWorkflowLocalAgent(options:WorkflowLocalAgentOptions) {
  const parent:ToolUseContext={...options.parent,isBackgroundAgent:true,setAppState:()=>{}}
  // Serialize worktree creation only; inference still uses dispatcher concurrency.
  let worktreeQueue:Promise<unknown>=Promise.resolve()
  const log=(message:string)=>options.onProgress({type:'progress',toolUseID:'workflow_log',data:{type:'workflow_log',message}})
  const aborted=()=>{if(parent.abortController.signal.aborted)throw Error('Workflow aborted')}
  return async(request:WorkflowAgentRequest):Promise<unknown>=>{
    aborted()
    const supplied=request.options, permissions=options.readPermissionContext(parent)
    if(permissions.mode==='auto') {
      const schema=schemaForClassification(supplied?.schema)
      const blocked=schema.error?{reason:schema.error}:await options.classifyDispatch({prompt:request.prompt,schemaJson:schema.json,
        agentType:supplied?.agentType!=null?String(supplied.agentType):undefined,parent,permissions}).catch(error=>{
          if(!parent.abortController.signal.aborted)options.onClassifierError(error)
          return null
        })
      aborted()
      if(blocked) {
        const error=`[${request.label}] blocked by safety classifier: ${blocked.reason}`
        options.recordFailure(error)
        options.onProgress({type:'progress',toolUseID:`workflow_agent_${request.index}_blocked`,data:{type:'workflow_agent',index:request.index,
          label:request.label,phaseIndex:request.phaseIndex,phaseTitle:request.phaseTitle,state:'error',blocked:true,error,
          model:supplied?.model??parent.options.mainLoopModel,queuedAt:request.queuedAt,promptPreview:workflowResultPreview(request.prompt),lastProgressAt:Date.now()}})
        return null
      }
    }
    let selected:AgentDefinition|undefined
    if(supplied?.agentType!=null) {
      const name=String(supplied.agentType),active=parent.options.agentDefinitions.activeAgents
      const allowed=filterDeniedAgents(active,options.readPermissionContext(parent),AGENT_TOOL_NAME)
      const definition=allowed.find(agent=>agent.agentType===name)
      if(!definition) {
        if(active.some(agent=>agent.agentType===name)) {
          const rule=getDenyRuleForAgent(options.readPermissionContext(parent),AGENT_TOOL_NAME,name)
          throw Error(`agent({agentType}): '${name}' is denied by permission rule '${AGENT_TOOL_NAME}(${name})' from ${rule?.source??'settings'}.`)
        }
        throw Error(`agent({agentType}): agent type '${name}' not found. Available agents: ${allowed.map(agent=>agent.agentType).join(', ')}`)
      }
      const suffix=supplied.schema?STRUCTURED_SUFFIX:TEXT_SUFFIX
      const disallowedTools=[...(definition.disallowedTools??[]),...DISALLOWED]
      const tools=supplied.schema && definition.tools && !definition.tools.includes('*')?[...definition.tools,SYNTHETIC_OUTPUT_TOOL_NAME]:definition.tools
      selected=isBuiltInAgent(definition)
        ? {...definition,disallowedTools,tools,getSystemPrompt:args=>definition.getSystemPrompt(args)+suffix}
        : {...definition,disallowedTools,tools,getSystemPrompt:()=>definition.getSystemPrompt()+suffix}
    }
    let structuredTool
    if(supplied?.schema) {
      const created=createSyntheticOutputTool(supplied.schema as Record<string,unknown>)
      if('error' in created)throw TypeError(`agent({schema}) received an invalid JSON Schema: ${created.error}`)
      structuredTool=created.tool
    }
    const base=selected??{...DEFAULT_AGENT,getSystemPrompt:()=>structuredTool?STRUCTURED_PROMPT:TEXT_PROMPT}
    const effort=parseEffortValue(supplied?.effort)
    const definition=effort===undefined?base:{...base,effort}
    const state=parent.getAppState(), currentPermissions=options.readPermissionContext(parent)
    const mcp:Tools=[...state.mcp.tools,...parent.options.tools.filter(tool=>tool.isMcp)]
    const pool=assembleToolPool({...currentPermissions,mode:definition.permissionMode??'acceptEdits'},mcp)
    const tools=structuredTool?[...pool.filter(tool=>!toolMatchesName(tool,SYNTHETIC_OUTPUT_TOOL_NAME)),structuredTool]:pool
    const model=getAgentModel(definition.model,parent.options.mainLoopModel,supplied?.model as string|undefined,currentPermissions.mode)
    let isolated:Awaited<ReturnType<typeof createAgentWorktree>>|undefined
    if(supplied?.isolation==='worktree') {
      const next=worktreeQueue.then(()=>createAgentWorktree(`${options.workflowRunId}-${request.index}`))
      worktreeQueue=next.catch(()=>{})
      isolated=await next
    }
    const prompt=isolated?`${request.prompt}\n\n---\nYou are running in an isolated git worktree at ${isolated.worktreePath} (a separate working copy of the repo). Changes you make here do NOT affect the main working directory (${getCwd()}) or other agents. Work normally — the worktree will be cleaned up automatically if you made no changes, or preserved for review if you did.`:request.prompt
    try {
      return await finishWorkflowAgent({label:request.label,stallMs:request.stallMs,signal:parent.abortController.signal,structured:!!structuredTool,
        sleep:(ms,signal)=>sleep(ms,signal,{throwOnAbort:true}),log,recordFailure:options.recordFailure,
        classifyHandoff:async(result,count)=>currentPermissions.mode==='auto' && result.agentMessages?
          classifyHandoffIfNeeded({agentMessages:result.agentMessages as ToolUseContext['messages'],tools,toolPermissionContext:currentPermissions,
            abortSignal:parent.abortController.signal,subagentType:definition.agentType,totalToolUseCount:count}):null,
        attempt:async(label,attempt,reason,cumulative)=>{
          aborted()
          const startedAt=Date.now(),agentId=createAgentId(),identity:SubagentContext={agentId,parentAgentId:options.parent.agentContext?.agentId,
            depth:(options.parent.agentContext?.depth??0)+1,parentSessionId:getSessionId(),agentType:'subagent',subagentName:definition.agentType,
            workflowRunId:options.workflowRunId,workflowName:options.workflowName,isAsync:false,isBackgroundAgent:true,isBuiltIn:isBuiltInAgent(definition),
            invokingRequestId:options.invokingRequestId,invocationKind:'spawn',invocationEmitted:false}
          request.onStarted(agentId)
          let fallbackModel:string|undefined
          const perform=()=>runWithAgentContext(identity,()=>runWorkflowAgentAttempt({signal:parent.abortController.signal,stallMs:request.stallMs,
            structured:!!structuredTool,autoMode:currentPermissions.mode==='auto',maxStructuredOutputRetries:options.maxStructuredOutputRetries??5,
            onController:controller=>options.onController(agentId,controller),countTokens:usage=>usage?getTokenCountFromUsage(usage as unknown as Parameters<typeof getTokenCountFromUsage>[0]):0,
            summarizeToolInput:summary,onModel:value=>{if(value!==model && getCanonicalName(value)!==getCanonicalName(model))fallbackModel=value},
            onProgress:(state,fields)=>options.onProgress({type:'progress',toolUseID:`workflow_agent_${request.index}_${agentId}`,data:{type:'workflow_agent',
              index:request.index,label,phaseIndex:request.phaseIndex,phaseTitle:request.phaseTitle,agentId,agentType:selected?.agentType,
              isolation:isolated?'worktree':undefined,model,fallbackModel,state,queuedAt:request.queuedAt,startedAt,attempt,lastAttemptReason:reason,
              promptPreview:workflowResultPreview(request.prompt),lastProgressAt:Date.now(),...fields,
              tokens:cumulative.tokens+Number(fields.tokens??0),toolCalls:cumulative.toolCalls+Number(fields.toolCalls??0),durationMs:cumulative.durationMs+Number(fields.durationMs??0)}}),
            makeStream:(controller,onQueryProgress)=>runAgent({agentDefinition:definition,promptMessages:[createUserMessage({content:prompt})],
              toolUseContext:{...parent,abortController:controller},canUseTool:options.canUseTool,isAsync:false,
              querySource:getQuerySourceForAgent(definition.agentType,isBuiltInAgent(definition)),availableTools:tools,requiresStructuredOutput:!!structuredTool,
              spawnedBySkill:parent.options.spawnedBySkill,spawnedByForkedSkill:parent.options.spawnedByForkedSkill,
              transcriptSubdir:`workflows/${options.workflowRunId}`,spawnedByWorkflowRunId:options.workflowRunId,
              override:{agentId,agentContext:identity},model:supplied?.model as string|undefined,onQueryProgress,
              onModelRestricted:(requested,resolved)=>{fallbackModel=resolved;log(`[${label}] model ${requested} restricted; using ${resolved}`)},
              worktreePath:isolated?.worktreePath}) as AsyncIterable<WorkflowAgentMessage>,
          }))
          return isolated?runWithCwdOverride(isolated.worktreePath,perform):perform()
        }})
    } finally {
      // Never delete a changed worktree. Existing shared lifecycle owns hooks
      // and cleanup; no new checkout is made outside explicit isolation.
      if(isolated && !isolated.hookBased && isolated.headCommit) {
        try {
          if(!await hasWorktreeChanges(isolated.worktreePath,isolated.headCommit))await removeAgentWorktree(isolated.worktreePath,isolated.worktreeBranch,isolated.gitRoot)
        } catch(error) {
          // Cleanup must not discard a successfully completed agent result.
          // Leave an unreadable/uncertain worktree intact for manual review.
          log(`[${request.label}] worktree cleanup could not complete; preserved ${isolated.worktreePath}`)
        }
      }
    }
  }
}
