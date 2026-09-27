import React,{useState} from 'react'
import {Box,Text} from '../../ink.js'
import {useSetAppState} from '../../state/AppState.js'
import {useTerminalSize} from '../../hooks/useTerminalSize.js'
import type {LocalWorkflowTaskState,WorkflowAgentProgress} from '../../tasks/LocalWorkflowTask/types.js'
import {buildResumePrompt,pauseWorkflowTask} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type {LocalJSXCommandOnDone} from '../../types/command.js'
import type {DeepImmutable} from '../../types/utils.js'
import {workflowDisplayText as display} from '../../tools/WorkflowTool/approval.js'
import {formatDuration} from '../../utils/format.js'
import {Dialog} from '../design-system/Dialog.js'
import {SaveWorkflowDialog} from './SaveWorkflowDialog.js'

type Props={workflow:DeepImmutable<LocalWorkflowTaskState>;onDone:LocalJSXCommandOnDone;onKill?:()=>void;
  onSkipAgent?:(id:string)=>void;onRetryAgent?:(id:string)=>void;onBack?:()=>void}
export function WorkflowDetailDialog({workflow,onDone,onKill,onSkipAgent,onRetryAgent,onBack}:Props) {
  const [index,setIndex]=useState(0),[raw,setRaw]=useState(false),[save,setSave]=useState(false),[expanded,setExpanded]=useState(false)
  const setAppState=useSetAppState(),{rows}=useTerminalSize()
  const agents=workflow.workflowProgress.filter((item):item is DeepImmutable<WorkflowAgentProgress>=>item.type==='workflow_agent')
  const selected=agents[Math.min(index,Math.max(0,agents.length-1))],visibleCount=Math.max(3,Math.min(12,rows-15))
  const offset=Math.max(0,Math.min(index-Math.floor(visibleCount/2),agents.length-visibleCount))
  const close=()=>onDone('Workflow details dismissed',{display:'system'})
  if(save)return <SaveWorkflowDialog script={workflow.script} defaultName={workflow.workflowName??'workflow'} onDone={message=>{setSave(false);if(message)onDone(message,{display:'system'})}}/>
  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={event=>{
    if(event.key==='up'){event.preventDefault();setIndex(Math.max(0,index-1))}
    else if(event.key==='down'){event.preventDefault();setIndex(Math.min(agents.length-1,index+1))}
    else if(event.key==='left'&&onBack){event.preventDefault();onBack()}
    else if(event.key===' '){event.preventDefault();close()}
    else if(event.key==='return'){event.preventDefault();setExpanded(!expanded)}
    else if(event.key==='v'){event.preventDefault();setRaw(!raw)}
    else if(event.key==='s'){event.preventDefault();setSave(true)}
    else if(event.key==='x'&&onKill){event.preventDefault();onKill()}
    else if(event.key==='p'&&workflow.status==='running'){event.preventDefault();pauseWorkflowTask(workflow.id,setAppState)}
    else if(event.key==='r'&&workflow.status!=='running'&&workflow.scriptPath){event.preventDefault();onDone(buildResumePrompt(workflow),{display:'user',shouldQuery:true})}
    else if(event.key==='k'&&selected?.agentId&&onSkipAgent){event.preventDefault();onSkipAgent(selected.agentId)}
    else if(event.key==='r'&&selected?.agentId&&onRetryAgent){event.preventDefault();onRetryAgent(selected.agentId)}
  }}><Dialog title={display(workflow.title??workflow.summary??workflow.description)} onCancel={onBack??close} inputGuide={()=>
    <Text>↑/↓ agent · Enter details · v script · s save{workflow.status==='running'?' · x stop · p pause · k skip · r retry':workflow.scriptPath?' · r resume':''} · Esc back</Text>}>
    <Text>{workflow.status} · {formatDuration((workflow.endTime??Date.now())-workflow.startTime)} · {workflow.totalTokens} tokens · {workflow.totalToolCalls} tool calls</Text>
    {raw?<Text>{display(workflow.script)}</Text>:<Box flexDirection="column">
      {workflow.phases?.map((phase,i)=><Text key={i} dimColor>{i+1}. {display(phase.title)}</Text>)}
      {agents.slice(offset,offset+visibleCount).map((agent,i)=><Text key={agent.index} color={offset+i===index?'permission':undefined}>
        {offset+i===index?'›':' '} {display(agent.label)} · {agent.state}{agent.cached?' (cached)':''}{agent.skipped?' (skipped)':''}{agent.blocked?' (blocked)':''} · {agent.tokens??0} tokens
      </Text>)}
      {!agents.length&&<Text dimColor>No agents started.</Text>}
      {expanded&&selected&&<Box flexDirection="column">
        <Text bold>{display(selected.phaseTitle??selected.label)}</Text>
        {selected.promptPreview&&<Text>{display(selected.promptPreview)}</Text>}
        {selected.resultPreview&&<Text>{display(selected.resultPreview)}</Text>}
        {selected.error&&<Text color="error">{display(selected.error)}</Text>}
      </Box>}
      {workflow.logs.slice(-5).map((log,i)=><Text key={i} dimColor>{display(log)}</Text>)}
      {workflow.error&&<Text color="error">{display(workflow.error)}</Text>}
      {workflow.result!==undefined&&<Text>{display(JSON.stringify(workflow.result,null,2))}</Text>}
    </Box>}
  </Dialog></Box>
}
