import {expect,test} from 'bun:test'
import type {Message} from '../types/message.js'
import {getWorkflowReminders,workflowReminderText} from './workflowReminders.js'
import {createUserMessage} from './messages.js'
import {createAttachmentMessage} from './attachments.js'

const base={input:'ultracode check this',mainThread:true,enabled:true,keywordEnabled:true,active:false,
  isHumanTypedPrompt:true,isRegularUserPrompt:true,messages:[] as Message[]}

test('only user provenance opts into workflows; expanded and quoted data do not',()=>{
  expect(getWorkflowReminders(base)).toEqual([{type:'workflow_keyword_request'}])
  for(const change of [{mainThread:false},{enabled:false},{keywordEnabled:false},{isHumanTypedPrompt:false},
    {suppressWorkflowKeyword:true},{preExpansionInput:'review [Pasted text #1]'},{input:'read `ultracode` documentation'},{input:'/ultracode'}]){
    expect(getWorkflowReminders({...base,...change})).toEqual([])
  }
})

test('session reminder enters once, repeats after ten real turns and exits once',()=>{
  const full=createAttachmentMessage({type:'ultra_effort_enter',reminderType:'full'})
  const on={...base,input:'check this',active:true}
  expect(getWorkflowReminders(on)).toEqual([{type:'ultra_effort_enter',reminderType:'full'}])
  expect(getWorkflowReminders({...on,messages:[full]})).toEqual([])
  const turns=Array.from({length:9},()=>createUserMessage({content:'next'}))
  const meta=createUserMessage({content:'internal',isMeta:true})
  const tool=createUserMessage({content:[{type:'tool_result',tool_use_id:'t',content:'done'}]})
  expect(getWorkflowReminders({...on,messages:[full,...turns,meta,tool]})).toEqual([])
  expect(getWorkflowReminders({...on,messages:[full,...turns,createUserMessage({content:'next'})]})).toEqual([{type:'ultra_effort_enter',reminderType:'sparse'}])
  expect(getWorkflowReminders({...on,active:false,messages:[full]})).toEqual([{type:'ultra_effort_exit'}])
  expect(getWorkflowReminders({...on,active:false,messages:[full,createAttachmentMessage({type:'ultra_effort_exit'})]})).toEqual([])
  expect(getWorkflowReminders({...on,isRegularUserPrompt:false})).toEqual([])
  expect(workflowReminderText({type:'ultra_effort_exit'})).toContain('standard opt-in rule')
})

test('size changes are announced once and unrestricted removes the guideline',()=>{
  const options={...base,input:'next',initialSize:'medium' as const,currentSize:'small' as const}
  expect(getWorkflowReminders(options)).toEqual([{type:'workflow_size_guideline_change',size:'small'}])
  const recorded=createAttachmentMessage({type:'workflow_size_guideline_change',size:'small'})
  expect(getWorkflowReminders({...options,messages:[recorded]})).toEqual([])
  expect(getWorkflowReminders({...options,currentSize:'unrestricted',messages:[recorded]})).toEqual([{type:'workflow_size_guideline_change',size:'unrestricted'}])
  expect(workflowReminderText({type:'workflow_size_guideline_change',size:'unrestricted'})).toBe('Workflow size is now unrestricted — no size guideline applies.')
})
