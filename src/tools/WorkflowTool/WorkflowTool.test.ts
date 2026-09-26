import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {createReadStream,openSync,readSync,closeSync} from 'node:fs'
import {parseExpressionAt} from 'acorn'
import type {ToolUseContext} from '../../Tool.js'
import {WORKFLOW_PROMPT} from './prompt.js'
import {MAX_WORKFLOW_SCRIPT_LENGTH} from './scriptParser.js'
import {WorkflowTool,isWorkflowRetracted,workflowInputSchema,workflowResultBlock,workflowSummary} from './WorkflowTool.js'

const script='export const meta={name:"review",description:"Review a change"};\n\treturn 42'

test('public schema requires a source, rejects unknown fields and bounds scripts',()=>{
  expect(workflowInputSchema.safeParse({}).success).toBe(false)
  expect(workflowInputSchema.safeParse({name:'review',remote:true}).success).toBe(false)
  expect(workflowInputSchema.safeParse({script}).success).toBe(true)
  expect(workflowInputSchema.safeParse({script:'x'.repeat(MAX_WORKFLOW_SCRIPT_LENGTH+1)}).success).toBe(false)
  expect(workflowInputSchema.safeParse({name:'review',resumeFromRunId:'../other-session'}).success).toBe(false)
  expect(workflowInputSchema.safeParse({name:'review',resumeFromRunId:'wf_abcd-1234',args:[1,false]}).success).toBe(true)
})

test('approval text allows tab/newline but rejects all hidden C0/C1 controls',()=>{
  for(let code=0;code<=0x9f;code++) {
    if(code>=0x20&&code<0x7f)continue
    const result=workflowInputSchema.safeParse({script:script+String.fromCharCode(code)})
    expect(result.success).toBe(code===9||code===10)
  }
})

test('public adapter remains disabled and cannot launch even if called directly',async()=>{
  expect(WorkflowTool.isEnabled()).toBe(false)
  const context={abortController:new AbortController()} as ToolUseContext
  await expect(WorkflowTool.call({script},context,async()=>{throw Error('disabled tool reached permissions')},undefined))
    .rejects.toThrow('Dynamic workflows are not enabled')
})

test('abort is checked before policy resolution or script execution',async()=>{
  const abortController=new AbortController()
  abortController.abort(new Error('fixture cancellation'))
  await expect(WorkflowTool.call({script},{abortController} as ToolUseContext,
    async()=>{throw Error('aborted tool reached permissions')},undefined)).rejects.toThrow('fixture cancellation')
})

test('only server fallback tombstones are classified as retractions',()=>{
  expect(isWorkflowRetracted(new AbortController().signal)).toBe(false)
  expect(isWorkflowRetracted(AbortSignal.abort('server-fallback-tombstone'))).toBe(true)
  expect(isWorkflowRetracted(AbortSignal.abort(new Error('server-fallback-tombstone')))).toBe(true)
  expect(isWorkflowRetracted(AbortSignal.abort('user cancelled'))).toBe(false)
})

test('summaries and result envelopes preserve source identity and error status',()=>{
  expect(workflowSummary({name:'review',script})).toBe('dynamic workflow: review')
  expect(workflowSummary({script})).toBe('Review a change')
  expect(workflowSummary({})).toBeNull()
  const data={status:'async_launched' as const,taskId:'task-one',taskType:'local_workflow' as const,
    workflowName:'review',runId:'wf_abcd-1234',summary:'Review a change',scriptPath:'/tmp/a"b.js'}
  const success=workflowResultBlock(data,'tool-one')
  expect(success.tool_use_id).toBe('tool-one')
  expect(success.is_error).toBe(false)
  expect(success.content).toContain(JSON.stringify(data.scriptPath))
  const error=workflowResultBlock({...data,error:'Unexpected token'},'tool-one')
  expect(error.is_error).toBe(true)
  expect(error.content).toContain('was not launched')
})

test('rendered pinned prompt remains byte-exact and retains explicit multi-agent opt-in',()=>{
  expect(createHash('sha256').update(WORKFLOW_PROMPT).digest('hex'))
    .toBe('1c3517d7d36a2713bd839290402123533d0df7343008783fc205266b265a2efc')
  expect(WORKFLOW_PROMPT).toContain('ONLY call this tool when the user has explicitly opted into multi-agent orchestration.')
})

const pinnedBinary=process.env.DARB_WORKFLOW_PINNED_BINARY
;(pinnedBinary?test:test.skip)('prompt matches only literal bindings from the SHA-pinned upstream binary',async()=>{
  const hash=createHash('sha256')
  for await(const chunk of createReadStream(pinnedBinary!))hash.update(chunk)
  expect(hash.digest('hex')).toBe('013a1cf17df5ff1dcc189d5d6fd3fdd5f097ddc3cd41aa9992e99805574febbe')
  const fd=openSync(pinnedBinary!,'r'),bytes=Buffer.alloc(269783626-245797944)
  try{expect(readSync(fd,bytes,0,bytes.length,245797944)).toBe(bytes.length)}finally{closeSync(fd)}
  const source=bytes.toString('utf8')
  const start=source.indexOf('Execute a workflow script that orchestrates')-1
  expect(start).toBeGreaterThan(0)
  const template=parseExpressionAt(source,start,{ecmaVersion:'latest'})
  if(template.type!=='TemplateLiteral')throw Error('Pinned prompt template drift')
  expect(createHash('sha256').update(source.slice(template.start,template.end)).digest('hex'))
    .toBe('e144edb6c9bf531454ffbcb8c98440a3a6d662129eea31ccc3b2c39b73963f36')
  // No binary execution or eval: the seven known bindings must be literals.
  const names=['_i','xKb','AKb','RKb','kKb','xNt','mse']
  const rendered=template.quasis.map((quasi,i)=>{
    if(quasi.value.cooked===null)throw Error('Invalid pinned escape')
    if(i===template.expressions.length)return quasi.value.cooked
    const expression=template.expressions[i]!
    if(expression.type!=='Identifier'||expression.name!==names[i])throw Error('Pinned binding drift')
    const hits=[...source.matchAll(new RegExp('(?<![\\w$])'+expression.name+'=(?!=)','g'))]
    expect(hits).toHaveLength(1)
    let literal=parseExpressionAt(source,hits[0]!.index!+expression.name.length+1,{ecmaVersion:'latest'})
    if(literal.type==='SequenceExpression')literal=literal.expressions[0]!
    if(literal.type!=='Literal'||!['string','number'].includes(typeof literal.value))throw Error('Non-literal binding')
    return quasi.value.cooked+String(literal.value)
  }).join('')
  expect(template.expressions).toHaveLength(names.length)
  expect(rendered).toBe(WORKFLOW_PROMPT)
})
