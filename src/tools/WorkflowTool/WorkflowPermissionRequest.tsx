import React,{useState} from 'react'
import {Box,Text} from '../../ink.js'
import type {PermissionRequestProps} from '../../components/permissions/PermissionRequest.js'
import {PermissionDialog} from '../../components/permissions/PermissionDialog.js'
import {PermissionPrompt,type PermissionPromptOption} from '../../components/permissions/PermissionPrompt.js'
import {editPromptInEditor} from '../../utils/promptEditor.js'
import {parseWorkflowScript} from './scriptParser.js'
import {validateReviewedWorkflow,workflowApproval,workflowDisplayText} from './approval.js'

export function WorkflowPermissionRequest({toolUseConfirm:confirm,onDone,onReject,workerBadge}:PermissionRequestProps) {
  const input=confirm.permissionResult.behavior==='ask'&&confirm.permissionResult.updatedInput?confirm.permissionResult.updatedInput:confirm.input
  const [script,setScript]=useState<string>(typeof input.script==='string'?input.script:'')
  const [raw,setRaw]=useState(false),[editError,setEditError]=useState<string>()
  const parsed=parseWorkflowScript(script),invalid=validateReviewedWorkflow(script)
  const meta='error'in parsed?undefined:parsed.meta
  const canRemember=Boolean(input.name&&!input.scriptPath&&confirm.permissionResult.behavior==='ask'&&confirm.permissionResult.suggestions?.some(update=>update.type==='addRules'))
  const options:PermissionPromptOption<string>[]=[]
  if(!invalid)options.push({label:'Yes, run it',value:'yes',feedbackConfig:{type:'accept'}})
  if(!invalid&&canRemember)options.push({label:`Yes, and don't ask again for ${workflowDisplayText(String(input.name))} in this project`,value:'yes-always'})
  options.push({label:raw?'View workflow summary':'View raw script',value:'toggle'},
    {label:'No',value:'no',feedbackConfig:{type:'reject'}})
  const reject=(feedback?:string)=>{onDone();onReject();confirm.onReject(feedback)}
  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={event=>{
    confirm.onUserInteraction()
    if(event.ctrl&&event.key==='g') {
      event.preventDefault()
      try{const result=editPromptInEditor(script);setEditError(result.error);if(result.content!==null){setScript(result.content);setRaw(false)}}
      catch(error){setEditError(String(error))}
    }
  }}><PermissionDialog title="Run a dynamic workflow?" workerBadge={workerBadge}>
    <Text bold>{workflowDisplayText(meta?.description??'Review workflow script')}</Text>
    {raw||!meta?.phases?<Text>{workflowDisplayText(script)}</Text>:<Box flexDirection="column">
      <Text>This dynamic workflow will run subagents across the following phases:</Text>
      {meta.phases.map((phase,index)=><Text key={index}>{index+1}. {workflowDisplayText(phase.title)}{phase.detail?` — ${workflowDisplayText(phase.detail)}`:''}</Text>)}
    </Box>}
    {input.args!==undefined&&<Text dimColor>args: {workflowDisplayText(JSON.stringify(input.args))}</Text>}
    {(invalid||editError)&&<Text color="error">{workflowDisplayText(invalid??editError!)}</Text>}
    <PermissionPrompt options={options} question="Workflows can use substantially more tokens than a single agent. Continue?" onCancel={()=>reject()} onSelect={(value:string,feedback?:string)=>{
      confirm.onUserInteraction()
      if(value==='toggle'){setRaw(!raw);return}
      if(value==='no'){reject(feedback);return}
      try{const result=workflowApproval(input,script,value==='yes-always');onDone();confirm.onAllow(result.updatedInput,result.permissionUpdates,feedback)}
      catch(error){setEditError(String(error))}
    }}/>
    <Text dimColor>Ctrl+G edit script in $EDITOR · /workflows watch progress</Text>
  </PermissionDialog></Box>
}
