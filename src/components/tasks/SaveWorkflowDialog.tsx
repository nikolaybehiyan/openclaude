import React,{useState} from 'react'
import {join} from 'node:path'
import {Box,Text} from '../../ink.js'
import {getCwd} from '../../utils/cwd.js'
import {getClaudeConfigHomeDir} from '../../utils/envUtils.js'
import {getEnabledSettingSources} from '../../utils/settings/constants.js'
import {saveWorkflow,WorkflowAlreadyExistsError} from '../../tools/WorkflowTool/saveWorkflow.js'
import {workflowDisplayText} from '../../tools/WorkflowTool/approval.js'
import {Dialog} from '../design-system/Dialog.js'
import TextInput from '../TextInput.js'
import {useTerminalSize} from '../../hooks/useTerminalSize.js'
import {refreshWorkflowCommands} from '../../utils/workflows.js'

export function SaveWorkflowDialog({script,defaultName,onDone}:{script:string;defaultName:string;onDone:(message?:string)=>void}) {
  const sources=getEnabledSettingSources()
  const {columns}=useTerminalSize()
  const [name,setName]=useState(defaultName),[cursor,setCursor]=useState(defaultName.length)
  const [scope,setScope]=useState<'projectSettings'|'userSettings'>(sources.includes('projectSettings')?'projectSettings':'userSettings')
  const [busy,setBusy]=useState(false),[exists,setExists]=useState(false),[error,setError]=useState<string>()
  const directory=scope==='projectSettings'?join(getCwd(),'.claude','workflows'):join(getClaudeConfigHomeDir(),'workflows')
  const clear=()=>{setExists(false);setError(undefined)}
  const submit=async()=>{
    if(busy||!sources.includes(scope))return
    setBusy(true)
    try {
      const saved=await saveWorkflow({name,script,directory,overwrite:exists})
      await refreshWorkflowCommands()
      onDone(`Dynamic workflow saved to ${saved.path}. Invoke as /${saved.name} or Workflow({name: ${JSON.stringify(saved.name)}}).`)
    }catch(error){if(error instanceof WorkflowAlreadyExistsError)setExists(true);else setError(String(error));setBusy(false)}
  }
  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={event=>{
    if(event.key==='tab'&&!busy&&sources.includes('userSettings')&&sources.includes('projectSettings')) {
      event.preventDefault();setScope(scope==='projectSettings'?'userSettings':'projectSettings');clear()
    }
  }}><Dialog title="Save dynamic workflow" onCancel={()=>onDone()} inputGuide={()=> <Text>Enter {exists?'overwrite':'save'} · Tab change scope · Esc cancel</Text>}>
    <Text dimColor>{scope==='projectSettings'?'Project':'User'}: {directory}</Text>
    <TextInput columns={Math.max(10,columns-6)} value={name} onChange={value=>{setName(value);clear()}} cursorOffset={cursor} onChangeCursorOffset={setCursor} onSubmit={()=>void submit()} focus={!busy} showCursor={!busy}/>
    {exists&&<Text color="warning">This file already exists. Press Enter again to overwrite, or change the name.</Text>}
    {error&&<Text color="error">{workflowDisplayText(error)}</Text>}
    {!sources.includes(scope)&&<Text color="error">Saving workflows is disabled by the enabled setting sources.</Text>}
    {busy&&<Text dimColor>Saving…</Text>}
  </Dialog></Box>
}
