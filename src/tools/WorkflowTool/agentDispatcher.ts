import {cpus} from 'node:os'
import {types} from 'node:util'
import {createWorkflowCombinators} from './combinators.ts'
import {workflowHostError} from './hostBoundary.ts'
import {workflowInvocationKey, type WorkflowJournalIndex, type WorkflowJournalRecord} from './journal.ts'
import type {WorkflowVMBridge, WorkflowVMFunction} from './vmBoundary.ts'
import type {WorkflowBudget, WorkflowHooks} from './vmRunner.ts'

export interface WorkflowAgentRequest {
  index: number
  prompt: string
  label: string
  phaseTitle?: string
  phaseIndex?: number
  stallMs: number
  options?: Record<string, unknown>
  queuedAt: number
  onStarted(agentId: string): void
}
export interface WorkflowProgressEvent {
  type: 'progress'
  toolUseID: string
  data: Record<string, unknown> & {type:'workflow_log'|'workflow_phase'|'workflow_agent'}
}

export class WorkflowAgentCapError extends Error {
  constructor() {
    super('Workflow agent() call cap reached (1000). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.')
    this.name='WorkflowAgentCapError'
  }
}
export class WorkflowBudgetExceededError extends Error {
  constructor(spent:number,total:number) {
    super(`Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} output tokens). Stopping further agent() calls. In-flight agents will complete; their results are preserved.`)
    this.name='WorkflowBudgetExceededError'
  }
}
export const workflowLocalConcurrency = (cpuCount:number) => Math.min(16,Math.max(2,cpuCount-2))

function limitConcurrency(limit:number) {
  let active=0
  const pending:(()=>void)[]=[]
  return <T>(fn:()=>Promise<T>):Promise<T> => new Promise((resolve,reject)=>{
    const launch=()=>{active++;Promise.resolve().then(fn).then(resolve,reject).finally(()=>{active--;pending.shift()?.()})}
    if(active<limit)launch();else pending.push(launch)
  })
}
function inertString(value:unknown):string {
  if(value===null || typeof value!=='object' && typeof value!=='function')return String(value)
  return `[${typeof value}]`
}
function preview(value:unknown):string|undefined {
  if(value==null)return
  const text=(typeof value==='string'?value:JSON.stringify(value)).trim()
  return text ? text.length>400 ? text.slice(0,400)+'…' : text : undefined
}

// ZNp dispatch accounting/replay/phase envelope. executeAgent is mandatory:
// the separately qualified adapter performs classifier, current CanUseTool,
// allowed-agent selection, structured-output enforcement and abort/retry.
// This module alone is not a replacement agent executor or a release gate.
export function createWorkflowAgentDispatcher(config:{
  executeAgent:(request:WorkflowAgentRequest)=>Promise<unknown>
  signal?:AbortSignal
  budget?:WorkflowBudget
  defaultModel:string
  seedPhaseTitles?:string[]
  cpuCount?:number
  onProgress:(event:WorkflowProgressEvent)=>void
  onJournalError?:(message:string)=>void
  journal?:{append(record:WorkflowJournalRecord):Promise<void>}
  replay?:WorkflowJournalIndex
  childWorkflow?:WorkflowVMFunction
}):WorkflowHooks & {resolvePhase:(title:string,kind?:string)=>number;recordFailure:(message:string)=>void} {
  let count=0,phaseTitle:string|undefined,phaseCount=0,previousKey='',replayMiss=false
  let boundary:WorkflowVMBridge
  const phases=new Map<string,number>(),failures:string[]=[],schemas=new WeakMap<object,unknown>()
  const queue=limitConcurrency(workflowLocalConcurrency(config.cpuCount??cpus().length))
  const bridge=()=>{if(!boundary)throw Error('Workflow VM boundary not bound');return boundary}
  function budgetGuard() {
    if(config.budget?.total==null || config.budget.total<=0)return
    const spent=config.budget.getTurnSpent()
    if(spent>=config.budget.total)throw new WorkflowBudgetExceededError(spent,config.budget.total)
  }
  function guard() {if(count>=1000)throw new WorkflowAgentCapError();budgetGuard()}
  function log(message:unknown) {
    config.onProgress({type:'progress',toolUseID:'workflow_log',data:{type:'workflow_log',message:inertString(message)}})
  }
  function resolvePhase(title:string,kind?:string) {
    let index=phases.get(title)
    if(index===undefined){index=++phaseCount;phases.set(title,index);config.onProgress({type:'progress',toolUseID:`workflow_phase_${index}`,data:{type:'workflow_phase',index,title,kind}})}
    return index
  }
  for(const title of config.seedPhaseTitles??[])resolvePhase(title)
  const combinators=createWorkflowCombinators({bridge,signal:config.signal,guard,recordFailure:message=>failures.push(message),log})
  async function agent(rawPrompt:unknown,rawOptions?:unknown) {
    let schemaIdentity:object|undefined
    if(rawOptions!==null && typeof rawOptions==='object' && !types.isProxy(rawOptions)) {
      const property=Object.getOwnPropertyDescriptor(rawOptions,'schema'),schema=property && 'value' in property ? property.value : undefined
      if(schema!==null && typeof schema==='object')schemaIdentity=schema
    }
    const snapshot=structuredClone(bridge().sanitize(rawOptions))
    const opts=snapshot && typeof snapshot==='object' ? snapshot as Record<string,unknown> : undefined
    if(opts && schemaIdentity) {
      if(!schemas.has(schemaIdentity))schemas.set(schemaIdentity,structuredClone(bridge().sanitize(schemaIdentity)))
      opts.schema=schemas.get(schemaIdentity)
    }
    if(config.signal?.aborted)return new Promise<never>(()=>{})
    try{guard()}catch(error){await new Promise(resolve=>setTimeout(resolve,0));throw error}
    const index=++count,prompt=inertString(rawPrompt)
    const label=(opts?.label!=null?String(opts.label):prompt.slice(0,60)).replace(/\s+/g,' ').trim()
    const ownPhase=opts?.phase!=null?String(opts.phase):phaseTitle
    const ownPhaseIndex=ownPhase===undefined?undefined:resolvePhase(ownPhase)
    const stallMs=opts?.stallMs!=null?Number(opts.stallMs):180000
    let key:string|undefined
    if(config.journal) {
      key=workflowInvocationKey(prompt,opts,previousKey);previousKey=key
      const cached=replayMiss?undefined:config.replay?.results.get(key)
      if(cached!==undefined) {
        const now=Date.now()
        config.onProgress({type:'progress',toolUseID:`workflow_agent_${index}_cached`,data:{type:'workflow_agent',index,label,phaseIndex:ownPhaseIndex,phaseTitle:ownPhase,agentId:cached.agentId,model:opts?.model??config.defaultModel,state:'done',startedAt:now,lastProgressAt:now,cached:true,resultPreview:preview(cached.result),promptPreview:preview(prompt)}})
        return bridge().clone(cached.result)
      }
      replayMiss=true
    }
    let started=false,agentId:string|undefined
    const queuedAt=Date.now()
    const onStarted=(id:string)=>{
      started=true;agentId=id
      if(config.journal && key)void config.journal.append({type:'started',key,agentId:id}).catch(error=>config.onJournalError?.(`workflow journal started-append failed: ${workflowHostError(error).message}`))
    }
    if(opts?.isolation==='remote')throw Error("agent({isolation:'remote'}) is not available in this build")
    config.onProgress({type:'progress',toolUseID:`workflow_agent_${index}_queued`,data:{type:'workflow_agent',index,label,phaseIndex:ownPhaseIndex,phaseTitle:ownPhase,agentType:opts?.agentType!=null?String(opts.agentType):undefined,isolation:opts?.isolation==='worktree'?'worktree':undefined,model:opts?.model??config.defaultModel,state:'start',queuedAt,promptPreview:preview(prompt),lastProgressAt:queuedAt}})
    try {
      const result=await queue(async()=>{budgetGuard();return config.executeAgent({index,prompt,label,phaseTitle:ownPhase,phaseIndex:ownPhaseIndex,stallMs,options:opts,queuedAt,onStarted})})
      if(config.journal && key && result!==null)await config.journal.append({type:'result',key,agentId:agentId??'',result}).catch(error=>config.onJournalError?.(`workflow journal result-append failed: ${workflowHostError(error).message}`))
      return result
    }catch(error) {
      if(!started && !config.signal?.aborted)config.onProgress({type:'progress',toolUseID:`workflow_agent_${index}_queued`,data:{type:'workflow_agent',index,label,phaseIndex:ownPhaseIndex,phaseTitle:ownPhase,model:opts?.model??config.defaultModel,state:'error',error:workflowHostError(error).message,queuedAt,promptPreview:preview(prompt),lastProgressAt:Date.now()}})
      if(config.signal?.aborted)return new Promise<never>(()=>{})
      throw error
    }
  }
  return {agent,...combinators,log,phase:value=>{phaseTitle=inertString(value);resolvePhase(phaseTitle)},resolvePhase,
    workflow:config.childWorkflow??(()=>{throw Error('Workflow child resolver not bound')}),
    bindVMAwait:value=>{boundary=value},getAgentCount:()=>count,getFailures:()=>failures,recordFailure:message=>failures.push(message)}
}
