import {expect,test} from 'bun:test'
import {PassThrough} from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import {createRoot} from '../../ink.js'
import {AppStateProvider} from '../../state/AppState.js'
import {KeybindingSetup} from '../../keybindings/KeybindingProviderSetup.js'
import {WorkflowPermissionRequest} from './WorkflowPermissionRequest.js'
import {WorkflowDetailDialog} from '../../components/tasks/WorkflowDetailDialog.js'
import {WorkflowHistoryDialog} from '../../commands/workflows/workflows.js'
import type {LocalWorkflowTaskState} from '../../tasks/LocalWorkflowTask/types.js'

async function render(node:React.ReactNode) {
  const stdout=new PassThrough(),stdin=new PassThrough() as any;let output=''
  Object.assign(stdout,{columns:120,rows:40,isTTY:true})
  Object.assign(stdin,{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}})
  stdout.on('data',chunk=>{output+=chunk})
  const root=await createRoot({stdout:stdout as any,stdin,patchConsole:false})
  root.render(<AppStateProvider><KeybindingSetup>{node}</KeybindingSetup></AppStateProvider>)
  await Bun.sleep(60)
  // Ink emits cursor-forward for blank cells in its terminal diff protocol.
  return {text:()=>stripAnsi(output.replace(/\u001b\[(\d*)C/g,(_match,count)=>' '.repeat(Number(count)||1))),key:async(key:string)=>{stdin.write(key);await Bun.sleep(70)},close:()=>root.unmount()}
}
const script='export const meta={name:"review",description:"Review a change",phases:[{title:"Inspect",detail:"Read only"}]};return 42'

test('actual approval UI renders summary and Enter approves the reviewed bytes',async()=>{
  const calls:any[]=[]
  const input={name:'review',args:'target'}
  const confirm:any={input,permissionResult:{behavior:'ask',updatedInput:{...input,script},suggestions:[{type:'addRules'}]},
    onUserInteraction:()=>{},onAllow:(...args:any[])=>calls.push(args),onReject:()=>{throw Error('Unexpected reject')}}
  const ui=await render(<WorkflowPermissionRequest toolUseConfirm={confirm} toolUseContext={{} as any} onDone={()=>{}} onReject={()=>{}} verbose={false} workerBadge={undefined}/>)
  try {
    expect(ui.text()).toContain('Run a dynamic workflow?');expect(ui.text()).toContain('Inspect')
    expect(ui.text()).toContain('Read only');expect(ui.text()).toContain('View raw script')
    await ui.key('\r')
    expect(calls).toHaveLength(1);expect(calls[0][0]).toEqual({...input,script});expect(calls[0][1]).toEqual([])
  }finally{ui.close()}
})

test('actual details UI supports agent retry, skip, stop and recovery prompt',async()=>{
  const actions:string[]=[],done:any[]=[]
  const workflow={id:'wf-ui',type:'local_workflow',status:'running',script,prompt:script,description:'Review a change',workflowRunId:'wf_abcdef',
    scriptPath:'/tmp/approved.js',startTime:Date.now(),workflowProgress:[{type:'workflow_agent',index:1,label:'Inspect files',state:'progress',agentId:'agent-one',promptPreview:'Read the approved target only'}],
    logs:[],totalTokens:25,totalToolCalls:2,agentCount:1} as unknown as LocalWorkflowTaskState
  const ui=await render(<WorkflowDetailDialog workflow={workflow} onDone={(...args)=>done.push(args)} onKill={()=>actions.push('kill')} onSkipAgent={id=>actions.push('skip:'+id)} onRetryAgent={id=>actions.push('retry:'+id)}/>)
  try {
    expect(ui.text()).toContain('Inspect files')
    // Terminal diff may reuse unchanged cells; this suffix appears only in details.
    await ui.key('\r');expect(ui.text()).toContain('target only')
    await ui.key('r');await ui.key('k');await ui.key('x')
    expect(actions).toEqual(['retry:agent-one','skip:agent-one','kill'])
  }finally{ui.close()}
  const paused=await render(<WorkflowDetailDialog workflow={{...workflow,status:'paused'}} onDone={(...args)=>done.push(args)}/>)
  try {
    await paused.key('r')
    expect(done[0][0]).toContain('resumeFromRunId: "wf_abcdef"');expect(done[0][1]).toEqual({display:'user',shouldQuery:true})
  }finally{paused.close()}
})

test('actual workflows command renders empty history and closes without querying',async()=>{
  const done:any[]=[]
  const ui=await render(<WorkflowHistoryDialog onDone={(...args)=>done.push(args)}/>)
  try {
    expect(ui.text()).toContain('Dynamic workflows')
    await ui.key('\u001b')
    expect(done).toEqual([['Dynamic workflows dialog dismissed',{display:'system'}]])
  }finally{ui.close()}
})
