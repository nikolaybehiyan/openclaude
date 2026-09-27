import {getInitialSettings} from './settings/settings.js'

export const WORKFLOW_SIZES=['unrestricted','small','medium','large'] as const
export type WorkflowSize=typeof WORKFLOW_SIZES[number]
const counts={small:5,medium:15,large:50}
const guideline="This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale."
let initial:{size:WorkflowSize;isDefault:boolean}|undefined

export function currentWorkflowSize():{size:WorkflowSize;isDefault:boolean} {
  const size=getInitialSettings().workflowSizeGuideline
  return size===undefined?{size:'medium',isDefault:true}:{size,isDefault:false}
}
export function initialWorkflowSize():WorkflowSize {
  initial??=currentWorkflowSize()
  return initial.size
}
const sizeText=(size:WorkflowSize)=>size==='unrestricted'?size:`${size} — keep workflows under ${counts[size]} agents`
export function workflowSizePrompt():string {
  initial??=currentWorkflowSize()
  if(initial.size==='unrestricted')return ''
  return `\n\n${initial.isDefault?'This session has the default workflow size guideline:':'A workflow size guideline is configured for this session:'} ${sizeText(initial.size)}. ${guideline}${initial.isDefault?' The user can raise or remove it with "Dynamic workflow size" in /config.':''}`
}
export function workflowSizeChangeText(size:WorkflowSize):string {
  return size==='unrestricted'?'Workflow size is now unrestricted — no size guideline applies.':`The workflow size guideline for this session changed: ${sizeText(size)}. ${guideline}`
}
