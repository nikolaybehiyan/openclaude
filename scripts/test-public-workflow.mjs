// End-to-end test of the built CLI. Only the inference server is a fixture;
// tool registration, permissions, task execution, child CLI query and history
// are real. No external service, credential or repository is used.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'

const cli=resolve(dirname(fileURLToPath(import.meta.url)),'../dist/cli.mjs')
const root=await mkdtemp(join(tmpdir(),'public-workflow-e2e-'))
const cwd=join(root,'workspace'),config=join(root,'config')
await mkdir(cwd);await mkdir(config)
const script='export const meta={name:"smoke",description:"One bounded child",phases:[{title:"Verify"}]};phase("Verify");return {answer:await agent("Return WORKFLOW_CHILD_OK",{label:"Smoke child"})}'
const slash=process.argv.includes('--slash')
if(slash){await mkdir(join(cwd,'.claude','workflows'),{recursive:true});await writeFile(join(cwd,'.claude','workflows','smoke.js'),script)}
const requests=[]
let parentRequests=0,children=0,failure

function respond(res,body,content){
  const tool=content.type==='tool_use'
  const message={id:'fixture-'+requests.length,type:'message',role:'assistant',model:body.model,
    content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}}
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...message,content:[content],stop_reason:tool?'tool_use':'end_turn',usage:{input_tokens:20,output_tokens:10}}));return}
  res.writeHead(200,{'content-type':'text/event-stream'})
  const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`)
  event('message_start',{message})
  event('content_block_start',{index:0,content_block:tool?{...content,input:{}}:{type:'text',text:''}})
  event('content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(content.input)}:{type:'text_delta',text:content.text}})
  event('content_block_stop',{index:0})
  event('message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:10}})
  event('message_stop',{});res.end()
}
const server=createServer(async(req,res)=>{
  try{
    let raw='';for await(const chunk of req)raw+=chunk
    const body=raw?JSON.parse(raw):{}
    if(req.url?.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":20}');return}
    if(!req.url?.startsWith('/v1/messages')){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return}
    assert.ok(requests.length<12,'Unexpected inference loop')
    requests.push(body)
    const parent=(body.tools??[]).some(tool=>tool.name==='Workflow')
    if(!parent){
      assert.match(JSON.stringify(body.messages),/WORKFLOW_CHILD_OK/)
      children++;respond(res,body,{type:'text',text:'WORKFLOW_CHILD_OK'});return
    }
    parentRequests++
    if(parentRequests===1){
      assert.match(JSON.stringify(body.messages),slash?/Run the \\"smoke\\" workflow/:/opting this turn into multi-agent orchestration/)
      respond(res,body,{type:'tool_use',id:'fixture-workflow',name:'Workflow',input:slash?{name:'smoke'}:{script}});return
    }
    const text=JSON.stringify(body.messages),taskId=text.match(/Task ID: (\w+)/)?.[1]
    assert.ok(taskId,'Workflow must return a task ID')
    if(!text.includes('WORKFLOW_CHILD_OK')){
      respond(res,body,{type:'tool_use',id:'fixture-output-'+parentRequests,name:'TaskOutput',input:{task_id:taskId,block:true,timeout:10000}});return
    }
    respond(res,body,{type:'text',text:'WORKFLOW_PARENT_OK'})
  }catch(error){failure=error;res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'api_error',message:String(error)}}))}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const env={...process.env}
for(const key of Object.keys(env))if(/^(DARB_|ANTHROPIC_|CLAUDE_|OPENCLAUDE_|OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/.test(key))delete env[key]
Object.assign(env,{CLAUDE_CONFIG_DIR:config,ANTHROPIC_API_KEY:'sk-ant-workflow-local-fixture',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_WORKFLOWS:'1',DISABLE_AUTOUPDATER:'1'})
let stdout='',stderr=''
try{
  const child=spawn(process.execPath,[cli,'-p',slash?'/smoke':'ultracode: run the bounded smoke workflow.',
    '--provider','anthropic','--model','claude-sonnet-4-6','--tools','Workflow,TaskOutput','--allowedTools','Workflow,TaskOutput',
    '--setting-sources',slash?'project':'','--settings','{"enableWorkflows":true}','--output-format','stream-json','--verbose','--max-turns','6'],{cwd,env,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk)
  const timer=setTimeout(()=>child.kill('SIGTERM'),45000)
  const code=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timer)
  if(failure)throw failure
  assert.equal(code,0,stderr+'\n'+stdout)
  assert.equal(children,1,'Exactly one child must execute')
  const frames=stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line))
  const result=frames.findLast(frame=>frame.type==='result')
  assert.equal(result?.is_error,false,JSON.stringify(result))
  assert.equal(result.result,'WORKFLOW_PARENT_OK')
  const snapshots=[]
  async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else if(entry.name==='snapshot.json')snapshots.push(JSON.parse(await readFile(path,'utf8')))}}
  await walk(config)
  assert.equal(snapshots.length,1)
  assert.equal(snapshots[0].task.status,'completed')
  assert.equal(snapshots[0].task.result.answer,'WORKFLOW_CHILD_OK')
  console.log(JSON.stringify({status:'pass',kind:'built-cli-local-inference-fixture',trigger:slash?'slash-command':'keyword',parentRequests,children,history:snapshots[0].task.status,runId:snapshots[0].task.workflowRunId}))
}catch(error){console.error(stderr);console.error(stdout.slice(-16000));throw error}
finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
