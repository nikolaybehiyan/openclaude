import type {Message} from '../types/message.js'
import {findUltracodeKeyword} from './ultracodePolicy.js'
import {workflowSizeChangeText,type WorkflowSize} from './workflowSize.js'

export type WorkflowReminder =
  | {type:'workflow_keyword_request'}
  | {type:'ultra_effort_enter';reminderType:'full'|'sparse'}
  | {type:'ultra_effort_exit'}
  | {type:'workflow_size_guideline_change';size:WorkflowSize}

export type WorkflowPromptOrigin = {
  isHumanTypedPrompt?:boolean
  isRegularUserPrompt?:boolean
  preExpansionInput?:string
  suppressWorkflowKeyword?:boolean
}

/** Pinned 2.1.226 HlS/MlS. Only the user-input owner can attest provenance;
 * expanded skills, tool results, subagents and inter-turn ticks cannot opt in. */
export function getWorkflowReminders(options:WorkflowPromptOrigin&{
  input:string|null
  mainThread:boolean
  enabled:boolean
  keywordEnabled:boolean
  active:boolean
  messages:readonly Message[]
  maintenanceTurns?:number
  currentSize?:WorkflowSize
  initialSize?:WorkflowSize
}):WorkflowReminder[] {
  if(!options.mainThread||!options.enabled)return[]
  const reminders:WorkflowReminder[]=[]
  const input=options.preExpansionInput??options.input
  if(options.isHumanTypedPrompt&&!options.suppressWorkflowKeyword&&options.keywordEnabled&&input&&findUltracodeKeyword(input).length){
    reminders.push({type:'workflow_keyword_request'})
  }
  if(!options.isRegularUserPrompt)return reminders
  const previousSize=options.messages.findLast(message=>message.type==='attachment'&&message.attachment.type==='workflow_size_guideline_change')
  const lastSize=previousSize?.type==='attachment'&&previousSize.attachment.type==='workflow_size_guideline_change'?previousSize.attachment.size:options.initialSize
  if(options.currentSize&&lastSize&&options.currentSize!==lastSize)reminders.push({type:'workflow_size_guideline_change',size:options.currentSize})
  let previous:'enter'|'exit'|undefined,turns=0
  for(let index=options.messages.length-1;index>=0;index--){
    const message=options.messages[index]!
    if(message.type==='attachment'){
      if(message.attachment.type==='ultra_effort_enter'){previous='enter';break}
      if(message.attachment.type==='ultra_effort_exit'){previous='exit';break}
    }else if(message.type==='user'&&!message.isMeta&&
      !(Array.isArray(message.message.content)&&message.message.content.some(block=>block.type==='tool_result'))){turns++}
  }
  const interval=options.maintenanceTurns
  const every=interval!==undefined&&Number.isSafeInteger(interval)&&interval>0?interval:10
  if(options.active){
    if(previous!=='enter')reminders.push({type:'ultra_effort_enter',reminderType:'full'})
    else if(turns>=every)reminders.push({type:'ultra_effort_enter',reminderType:'sparse'})
  }else if(previous==='enter')reminders.push({type:'ultra_effort_exit'})
  return reminders
}

export function workflowReminderText(reminder:WorkflowReminder):string {
  switch(reminder.type){
    case 'workflow_keyword_request':return 'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request.'
    case 'ultra_effort_enter':return reminder.reminderType==='full'
      ?"Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool's **Ultracode** section and quality patterns. Solo only on conversational/trivial turns."
      :"Ultracode is still on — use the Workflow tool; see its Ultracode section."
    case 'ultra_effort_exit':return "Ultracode is off — the Workflow tool's standard opt-in rule applies again."
    case 'workflow_size_guideline_change':return workflowSizeChangeText(reminder.size)
  }
}
