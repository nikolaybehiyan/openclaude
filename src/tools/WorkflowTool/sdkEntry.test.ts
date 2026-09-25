import {afterAll,beforeEach,expect,mock,test} from 'bun:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {getEmptyToolPermissionContext,type ToolUseContext} from '../../Tool.js'
import {setCwdState,setIsInteractive} from '../../bootstrap/state.js'
import {createFileStateCacheWithSizeLimit} from '../../utils/fileStateCache.js'
const queryModule=await import('../../query.js'),storage=await import('../../utils/sessionStorage.js'),hooks=await import('../../utils/hooks.js')
const settings=await import('../../utils/settings/settings.js')
let calls=0,waitForAbort=false
mock.module('../../query.js',()=>({...queryModule,query:async function*(params:any){
 calls++
 if(waitForAbort){await new Promise<void>(resolve=>params.toolUseContext.abortController.signal.addEventListener('abort',()=>resolve(),{once:true}));throw Error('workflow aborted')}
 const prompt=JSON.stringify(params.messages)
 const data=prompt.includes('Decompose this research')?{question:'test question',summary:'scope',angles:[{label:'one',query:'one'},{label:'two',query:'two'},{label:'three',query:'three'}]}:
  prompt.includes('Synthesize')||prompt.includes('synthesize')?{summary:'No reliable sources found',findings:[],caveats:'fixture'}:{results:[]}
 yield {type:'attachment',attachment:{type:'structured_output',data}}
 yield {type:'assistant',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'text',text:'done'}],usage:{input_tokens:1,output_tokens:1}}}
}}))
mock.module('../../utils/sessionStorage.js',()=>({...storage,recordSidechainTranscript:async()=>{},writeAgentMetadata:async()=>{}}))
mock.module('../../utils/hooks.js',()=>({...hooks,executeSubagentStartHooks:async function*(){}}))
mock.module('../../utils/settings/settings.js',()=>({...settings,getInitialSettings:()=>({}),getSettings_DEPRECATED:()=>({})}))
const {startBundledWorkflow}=await import('./sdkEntry.js')
const root=await mkdtemp(join(tmpdir(),'sdk-workflow-entry-'));const prior=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=root
setCwdState(root);setIsInteractive(false)
afterAll(async()=>{mock.restore();if(prior===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=prior;await rm(root,{recursive:true,force:true})})
beforeEach(()=>{calls=0;waitForAbort=false})
function fixture(){let state:any={toolPermissionContext:getEmptyToolPermissionContext(),todos:{},tasks:{},mcp:{tools:[]}}
 const parent={options:{mainLoopModel:'claude-sonnet-4-6',tools:[],commands:[],thinkingConfig:{type:'disabled'},mcpClients:[],mcpResources:{},isNonInteractiveSession:true,agentDefinitions:{activeAgents:[]}},abortController:new AbortController(),readFileState:createFileStateCacheWithSizeLimit(100),getAppState:()=>state,setAppState:(fn:any)=>{state=fn(state)},messages:[]} as unknown as ToolUseContext
 return parent
}
test('SDK entry checks permission before execution and rejects non-bundled scripts',async()=>{
 const parent=fixture()
 await expect(startBundledWorkflow({name:'deep-research',args:'question'},parent,async()=>({behavior:'deny',message:'denied',decisionReason:{type:'other',reason:'fixture'}}))).rejects.toThrow('permission denied')
 await expect(startBundledWorkflow({name:'unknown' as any,args:'question'},parent,async()=>{throw Error('permission should not be called')})).rejects.toThrow()
 expect(calls).toBe(0)
})
test('actual pinned workflow executes through real dispatcher and runAgent then replays without inference',async()=>{
 const parent=fixture(),progress:any[]=[],allow:any=async(_tool:any,input:any)=>({behavior:'allow',updatedInput:input})
 const run=await startBundledWorkflow({name:'deep-research',args:'test question',onProgress:p=>progress.push(p)},parent,allow)
 const result=await run.completion
 expect(result.error).toBeUndefined();expect(result.result).toBeTruthy();expect(calls).toBeGreaterThanOrEqual(4)
 expect(progress.some(p=>p.data.type==='workflow_agent')).toBe(true)
 const before=calls
 const resumed=await startBundledWorkflow({name:'deep-research',args:'test question',resumeFromRunId:run.runId},parent,allow)
 expect((await resumed.completion).result).toEqual(result.result);expect(calls).toBe(before)
})
test('parent interrupt aborts running children and completion releases its durable lease',async()=>{
 waitForAbort=true
 const parent=fixture(),allow:any=async(_tool:any,input:any)=>({behavior:'allow',updatedInput:input})
 const run=await startBundledWorkflow({name:'deep-research',args:'test question'},parent,allow)
 while(!calls)await new Promise(resolve=>setTimeout(resolve,5))
 parent.abortController.abort(new Error('user stopped'))
 expect((await run.completion).error).toBeDefined()
},5000)
test('SDK timeout stops child execution and remains a timeout at the host boundary',async()=>{
 waitForAbort=true
 const run=await startBundledWorkflow({name:'deep-research',args:'test question',timeoutMs:40},fixture(),async(_tool,input)=>({behavior:'allow',updatedInput:input}))
 expect((await run.completion).error).toBe('Workflow timed out')
})
