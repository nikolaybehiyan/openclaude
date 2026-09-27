import {afterAll,expect,test} from 'bun:test'
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {getSessionId} from '../../bootstrap/state.js'
import type {LoadedPlugin} from '../../types/plugin.js'
import type {LocalWorkflowTaskState} from '../../tasks/LocalWorkflowTask/types.js'
import {PluginManifestSchema} from '../../utils/plugins/schemas.js'
import {workflowApproval,validateReviewedWorkflow} from './approval.js'
import {createWorkflowCommand} from './createWorkflowCommand.js'
import {discoverPluginWorkflows} from './pluginWorkflows.js'
import {WorkflowRegistry} from './registry.js'
import {saveWorkflow,WorkflowAlreadyExistsError} from './saveWorkflow.js'
import {loadWorkflowHistory,persistWorkflowTask} from './history.js'

const root=await mkdtemp(join(tmpdir(),'workflow-public-'))
afterAll(()=>rm(root,{recursive:true,force:true}))
const script='export const meta={name:"review",description:"Review",whenToUse:"Inspect changes",phases:[{title:"Check",detail:"Read files"}]};return args'

test('slash expansion preserves the 226 command contract and JSON-quotes user input',async()=>{
  const command=createWorkflowCommand({source:'built-in',name:'review',description:'Review',whenToUse:'Inspect changes',phases:[{title:'Check',detail:'Read files'}],script})
  expect(command.kind).toBe('workflow');expect(command.source).toBe('bundled');expect(command.loadedFrom).toBe('bundled')
  expect(await command.getPromptForCommand('  a"b\nline  ',{} as any)).toEqual([{type:'text',text:'Run the "review" workflow.\n\nReview\n\nInspect changes\n\nPhases:\n- Check: Read files\n\nInvoke: Workflow({ name: "review", args: "a\\"b\\nline" })'}])
  expect((await command.getPromptForCommand('',{} as any))[0]).toEqual({type:'text',text:expect.stringContaining('Workflow({ name: "review" })')})
})

test('approval freezes edited bytes, retains args and resume ID, and grants only the chosen named rule',()=>{
  const input={name:'review',args:{branch:'main'},resumeFromRunId:'wf_abcdef'}
  const result=workflowApproval(input,script,true)
  expect(result.updatedInput).toEqual({...input,script})
  expect(result.permissionUpdates).toEqual([{type:'addRules',rules:[{toolName:'Workflow',ruleContent:'review'}],behavior:'allow',destination:'localSettings'}])
  expect(workflowApproval({scriptPath:'/tmp/review.js'},script,false).permissionUpdates).toEqual([])
  expect(()=>workflowApproval({name:'review',scriptPath:'/tmp/review.js'},script,true)).toThrow('Only named')
  expect(()=>workflowApproval(input,script+'\u001b',false)).toThrow('hidden control')
  expect(validateReviewedWorkflow('bad script')).toBeDefined()
})

test('plugin schema accepts workflow paths, rejects absolute paths, explicit empty list is meaningful',()=>{
  expect(PluginManifestSchema().parse({name:'example',workflows:['./flows','./one.js']}).workflows).toEqual(['./flows','./one.js'])
  expect(PluginManifestSchema().parse({name:'example',workflows:[]}).workflows).toEqual([])
  expect(PluginManifestSchema().safeParse({name:'example',workflows:'/tmp/escape.js'}).success).toBe(false)
  expect(PluginManifestSchema().parse({name:'example',experimental:{workflows:['./flows']}}).experimental?.workflows).toEqual(['./flows'])
  expect(PluginManifestSchema().safeParse({name:'example',experimental:{workflows:'/tmp/escape.js'}}).success).toBe(false)
})

test('plugins use default or explicit paths, namespace collisions, disabled filtering and bounded reads',async()=>{
  const directory=join(root,'plugin');await mkdir(join(directory,'workflows'),{recursive:true});await mkdir(join(directory,'custom'))
  await writeFile(join(directory,'workflows','review.js'),script)
  await writeFile(join(directory,'custom','review.js'),script.replace('return args','return 43'))
  await writeFile(join(directory,'custom','invalid.js'),'throw Error("not metadata")')
  const base={name:'example',source:'example@market',path:directory,manifest:{name:'example'},repository:'market',enabled:true} satisfies LoadedPlugin
  const errors:Error[]=[]
  const defs=await discoverPluginWorkflows([base],(_file,error)=>errors.push(error))
  expect(defs.map(item=>item.name)).toEqual(['example:review'])
  const registry=new WorkflowRegistry({builtins:[],plugins:async()=>defs})
  const approved=await registry.resolve({name:'example:review'},root)
  expect(approved.meta.name).toBe('review');expect(approved.isVerbatimBuiltIn).toBe(false)
  expect(createWorkflowCommand(defs[0]!).pluginInfo?.repository).toBe('example@market')
  const explicit=await discoverPluginWorkflows([{...base,manifest:{...base.manifest,workflows:['./custom','./custom/review.js']}}],(_file,error)=>errors.push(error))
  expect(explicit).toHaveLength(1);expect(explicit[0]!.script).toContain('return 43');expect(errors).toHaveLength(1)
  expect(await discoverPluginWorkflows([{...base,manifest:{...base.manifest,workflows:[]}},{...base,enabled:false}],()=>{})).toEqual([])
  const experimental=await discoverPluginWorkflows([{...base,manifest:{...base.manifest,workflows:'./workflows',experimental:{workflows:'./custom/review.js'}}}],()=>{})
  expect(experimental).toHaveLength(1);expect(experimental[0]!.script).toContain('return 43')
  const external=join(root,'external.js');await writeFile(external,script);await symlink(external,join(directory,'custom','escape.js'))
  const noEscape=await discoverPluginWorkflows([{...base,manifest:{...base.manifest,workflows:'./custom'}}],(_file,error)=>errors.push(error))
  expect(noEscape).toHaveLength(1);expect(errors.some(error=>error.message.includes('escapes'))).toBe(true)
})

test('save writes a reusable metadata name, refuses overwrite until chosen and refuses links',async()=>{
  const directory=join(root,'saved')
  const first=await saveWorkflow({directory,name:'new-review',script})
  expect(await readFile(first.path,'utf8')).toContain('name:"new-review"')
  await expect(saveWorkflow({directory,name:'new-review',script})).rejects.toBeInstanceOf(WorkflowAlreadyExistsError)
  await saveWorkflow({directory,name:'new-review',script:script.replace('return args','return 44'),overwrite:true})
  expect(await readFile(first.path,'utf8')).toContain('return 44')
  await expect(saveWorkflow({directory,name:'../outside',script})).rejects.toThrow('Use 1–80')
  await symlink(first.path,join(directory,'linked.js'))
  await expect(saveWorkflow({directory,name:'linked',script,overwrite:true})).rejects.toThrow()
  expect(await readFile(first.path,'utf8')).toContain('return 44')
})

test('history preserves completed runs across reload, respects session ownership and treats stale running as paused',async()=>{
  const directory=join(root,'runs')
  const task={id:'workflow-task',type:'local_workflow',status:'running',workflowRunId:'wf_abcdef',startTime:10,
    script,prompt:script,description:'Review',workflowProgress:[],logs:[],progressVersion:0,agentCount:0,totalTokens:0,totalToolCalls:0,
    outputFile:'',outputOffset:0,notified:false,abortController:new AbortController(),agentControllers:new Map()} as LocalWorkflowTaskState
  await persistWorkflowTask(task,directory)
  expect((await loadWorkflowHistory(directory))[0]?.status).toBe('paused')
  expect(await loadWorkflowHistory(directory,'another-session')).toEqual([])
  await Promise.all([persistWorkflowTask({...task,status:'paused'},directory),persistWorkflowTask({...task,status:'completed',result:42},directory)])
  const [saved]=await loadWorkflowHistory(directory)
  expect(saved?.status).toBe('completed');expect(saved?.result).toBe(42);expect((saved as any)?.abortController).toBeUndefined()
  const other=join(directory,'wf_corrupt');await mkdir(other);await writeFile(join(other,'snapshot.json'),'{')
  expect(await loadWorkflowHistory(directory,getSessionId())).toHaveLength(1)
})
