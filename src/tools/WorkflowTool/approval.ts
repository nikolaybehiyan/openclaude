import type {PermissionUpdate} from '../../utils/permissions/PermissionUpdateSchema.js'
import type {WorkflowInput} from './registry.js'
import {MAX_WORKFLOW_SCRIPT_LENGTH,parseWorkflowScript} from './scriptParser.js'

export type WorkflowApprovalInput=WorkflowInput&{args?:unknown}
export function validateReviewedWorkflow(script:string):string|undefined {
  if(Buffer.byteLength(script)>MAX_WORKFLOW_SCRIPT_LENGTH)return 'Workflow script exceeds the size limit'
  if(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(script))return 'Workflow script contains hidden control characters'
  const parsed=parseWorkflowScript(script)
  return 'error'in parsed?parsed.error:undefined
}
export function workflowApproval(input:WorkflowApprovalInput,script:string,always:boolean):{updatedInput:WorkflowApprovalInput;permissionUpdates:PermissionUpdate[]} {
  const error=validateReviewedWorkflow(script)
  if(error)throw Error(error)
  if(always&&(!input.name||input.scriptPath))throw Error('Only named workflows can have a persistent permission')
  return {updatedInput:{...input,script},permissionUpdates:always?[{
    type:'addRules',rules:[{toolName:'Workflow',ruleContent:input.name!}],behavior:'allow',destination:'localSettings',
  }]:[]}
}
export const workflowDisplayText=(text:string):string=>text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`)
