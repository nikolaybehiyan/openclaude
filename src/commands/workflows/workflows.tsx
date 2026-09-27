import React,{useEffect,useState} from 'react'
import {Box,Text} from '../../ink.js'
import {useAppState,useSetAppState} from '../../state/AppState.js'
import {Dialog} from '../../components/design-system/Dialog.js'
import {Select} from '../../components/CustomSelect/select.js'
import {WorkflowDetailDialog} from '../../components/tasks/WorkflowDetailDialog.js'
import {isLocalWorkflowTask,killWorkflowTask,retryWorkflowAgent,skipWorkflowAgent} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {loadWorkflowHistory} from '../../tools/WorkflowTool/history.js'
import {workflowDisplayText} from '../../tools/WorkflowTool/approval.js'
import type {LocalJSXCommandOnDone} from '../../types/command.js'
import type {LocalWorkflowTaskState} from '../../tasks/LocalWorkflowTask/types.js'
import type {DeepImmutable} from '../../types/utils.js'

export function WorkflowHistoryDialog({onDone}:{onDone:LocalJSXCommandOnDone}) {
  const tasks=useAppState(state=>state.tasks),setAppState=useSetAppState()
  const [history,setHistory]=useState<DeepImmutable<LocalWorkflowTaskState>[]>([]),[loading,setLoading]=useState(true)
  const [selected,setSelected]=useState<string>(),[error,setError]=useState<string>()
  useEffect(()=>{let active=true;void loadWorkflowHistory().then(items=>{if(active)setHistory(items)},error=>{if(active)setError(String(error))}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[])
  const merged=new Map(history.map(task=>[task.workflowRunId,task]))
  for(const task of Object.values(tasks))if(isLocalWorkflowTask(task))merged.set(task.workflowRunId,task)
  const workflows=[...merged.values()].sort((a,b)=>b.startTime-a.startTime),workflow=workflows.find(task=>task.id===selected)
  if(workflow)return <WorkflowDetailDialog workflow={workflow} onDone={onDone} onBack={()=>setSelected(undefined)}
    onKill={workflow.status==='running'?()=>killWorkflowTask(workflow.id,setAppState):undefined}
    onSkipAgent={workflow.status==='running'?id=>skipWorkflowAgent(workflow.id,id,setAppState):undefined}
    onRetryAgent={workflow.status==='running'?id=>retryWorkflowAgent(workflow.id,id,setAppState):undefined}/>
  return <Dialog title="Dynamic workflows" onCancel={()=>onDone('Dynamic workflows dialog dismissed',{display:'system'})} inputGuide={()=> <Text>↑/↓ select · Enter view · Esc close</Text>}>
    <Box flexDirection="column">
      {loading&&<Text dimColor>Loading dynamic workflow history…</Text>}
      {error&&<Text color="error">{workflowDisplayText(error)}</Text>}
      {!loading&&!workflows.length&&<Text dimColor>No dynamic workflows in this session.</Text>}
      {workflows.length>0&&<Select options={workflows.map(task=>({value:task.id,label:`${workflowDisplayText(task.title??task.summary??task.description)} · ${task.status}`}))} onChange={setSelected} visibleOptionCount={10}/>}
    </Box>
  </Dialog>
}
export async function call(onDone:LocalJSXCommandOnDone):Promise<React.ReactNode>{return <WorkflowHistoryDialog onDone={onDone}/>}
