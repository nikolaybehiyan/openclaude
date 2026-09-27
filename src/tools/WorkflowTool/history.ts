import {constants} from 'node:fs'
import {mkdir,open,readdir,rename,unlink} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {getSessionId} from '../../bootstrap/state.js'
import {getTranscriptPath} from '../../utils/sessionStorage.js'
import type {LocalWorkflowTaskState} from '../../tasks/LocalWorkflowTask/types.js'
import {parseWorkflowScript} from './scriptParser.js'

const MAX_SNAPSHOT_BYTES=4*1024*1024
export const getWorkflowRunDirectory=()=>join(dirname(getTranscriptPath()),getSessionId(),'workflow-runs')
type SavedWorkflow=Omit<LocalWorkflowTaskState,'abortController'|'agentControllers'|'outputReady'>
export function workflowSnapshot(task:LocalWorkflowTaskState):SavedWorkflow {
  const {abortController,agentControllers,outputReady,...snapshot}=task
  return snapshot
}
const writes=new Map<string,Promise<void>>()
export function persistWorkflowTask(task:LocalWorkflowTaskState,root=getWorkflowRunDirectory()):Promise<void> {
  if(!/^wf_[a-z0-9-]{6,}$/.test(task.workflowRunId))return Promise.resolve()
  const snapshot=JSON.stringify({version:1,sessionId:getSessionId(),task:workflowSnapshot(task)})
  if(Buffer.byteLength(snapshot)>MAX_SNAPSHOT_BYTES)return Promise.reject(Error('Workflow history snapshot exceeds limit'))
  const directory=join(root,task.workflowRunId),file=join(directory,'snapshot.json')
  const write=(writes.get(file)??Promise.resolve()).catch(()=>{}).then(async()=>{
    await mkdir(directory,{recursive:true,mode:0o700})
    const temp=join(directory,`.snapshot-${randomUUID()}`)
    const handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    try{await handle.writeFile(snapshot);await handle.sync();await handle.close();await rename(temp,file)}
    finally{await handle.close().catch(()=>{});await unlink(temp).catch(()=>{})}
  })
  writes.set(file,write)
  void write.finally(()=>{if(writes.get(file)===write)writes.delete(file)}).catch(()=>{})
  return write
}

export async function loadWorkflowHistory(root=getWorkflowRunDirectory(),sessionId:string=getSessionId()):Promise<SavedWorkflow[]> {
  let entries
  try{entries=await readdir(root,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error}
  const tasks:SavedWorkflow[]=[]
  for(const entry of entries) {
    if(!entry.isDirectory()||!/^wf_[a-z0-9-]{6,}$/.test(entry.name))continue
    try {
      const handle=await open(join(root,entry.name,'snapshot.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
      let value
      try {
        const stat=await handle.stat()
        if(!stat.isFile()||stat.size>MAX_SNAPSHOT_BYTES||stat.nlink!==1)continue
        const bytes=Buffer.alloc(Math.min(stat.size+1,MAX_SNAPSHOT_BYTES+1))
        let count=0
        while(count<bytes.length){const next=await handle.read(bytes,count,bytes.length-count,null);if(!next.bytesRead)break;count+=next.bytesRead}
        if(count!==stat.size)continue
        value=JSON.parse(bytes.subarray(0,count).toString())
      }finally{await handle.close()}
      const task=value?.task
      if(value.version!==1||value.sessionId!==sessionId||task?.type!=='local_workflow'||task.workflowRunId!==entry.name||
        typeof task.id!=='string'||typeof task.script!=='string'||typeof task.startTime!=='number'||
        !['running','paused','completed','failed','killed'].includes(task.status)||!Array.isArray(task.workflowProgress)||!Array.isArray(task.logs))continue
      if('error'in parseWorkflowScript(task.script))continue
      tasks.push({...task,abortController:undefined,agentControllers:undefined,outputReady:undefined,
        // A snapshot is history, never proof of a live process. Live AppState
        // wins when merged by the UI. A stale lease still blocks execution.
        status:task.status==='running'?'paused':task.status,notified:true})
    }catch{/* A partial/corrupt individual snapshot must not hide the remaining history. */}
  }
  return tasks.sort((a,b)=>b.startTime-a.startTime)
}
