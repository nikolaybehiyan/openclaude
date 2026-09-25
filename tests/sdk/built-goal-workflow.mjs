// Run after the product-profile build: node tests/sdk/built-goal-workflow.mjs
// Loopback provider + MCP fixtures only: this is NOT real-provider E2E.
import http from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtemp,rm,writeFile,readdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
const root=await mkdtemp(join(tmpdir(),'darb-sdk-wire-'))
for(const key of Object.keys(process.env))if(/^(ANTHROPIC|CLAUDE|OPENCLAUDE|OPENAI|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS)/.test(key))delete process.env[key]
Object.assign(process.env,{CLAUDE_CONFIG_DIR:root,ANTHROPIC_API_KEY:'fixture-local-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY:'1',NO_PROXY:'127.0.0.1,localhost'})
let requests=0,evaluations=0,ordinary=0,structured=0,webCalls=0,impossible=false,unmet=false,hold=false;const kinds=[]
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk
 if(!req.url.startsWith('/v1/messages')){res.writeHead(404).end();return}
 const b=JSON.parse(raw);requests++;if(requests===1)console.log(JSON.stringify({test:'loopback tools',toolNames:b.tools?.map(x=>x.name)}))
 if(hold)return
 let content,stop='end_turn'
 const system=JSON.stringify(b.system??'')
 const tool=b.tools?.find(t=>t.name==='StructuredOutput')
 const schema=tool?.input_schema?.properties??{}
 if(system.includes('stopping condition')||system.includes('stop-condition')||system.includes('stopping-condition')){
  evaluations++;kinds.push('goal-eval');content=[{type:'text',text:JSON.stringify({ok:!impossible&&!unmet&&evaluations>=2,impossible,reason:impossible?'Fixture impossible':evaluations>=2?'Fixture goal met':'Fixture needs a second iteration'})}]
 }else if(tool){
  const prior=b.messages.flatMap(m=>Array.isArray(m.content)?m.content:[])
  const finished=prior.some(c=>c.type==='tool_use'&&c.name==='StructuredOutput')
  const web=b.tools.find(t=>t.name.endsWith(schema.claims?'web_fetch':'web_search'))
  if(finished){content=[{type:'text',text:'done'}];kinds.push('structured-finish')}
  else if(web&&(schema.results||schema.claims||schema.refuted)&&!prior.some(c=>c.type==='tool_use'&&c.name===web.name)){
   stop='tool_use';content=[{type:'tool_use',id:'web_'+requests,name:web.name,input:schema.claims?{url:'https://source.example.test/fact'}:{query:'fixture question'}}];kinds.push('web-tool')
  }else{
   structured++;stop='tool_use'
   const value=schema.angles?{question:'Wire fixture question',summary:'Scope fixture',angles:['one','two','three'].map(x=>({label:x,query:x}))}:
     schema.findings?{summary:'Verified fixture report',findings:[{claim:'Fixture fact',confidence:'high',sources:['https://source.example.test/fact'],evidence:'Fixture evidence'}],caveats:'Simulated provider, not real research'}:
     schema.claims?{sourceQuality:'primary',claims:[{claim:'Fixture fact',quote:'Fixture evidence',importance:'central'}]}:
     schema.refuted?{refuted:false,evidence:'Fixture evidence',confidence:'high'}:
     {results:[{url:'https://source.example.test/fact',title:'Fixture source',relevance:'high'}]}
   content=[{type:'tool_use',id:'tool_'+requests,name:'StructuredOutput',input:value}];kinds.push(schema.angles?'scope':schema.findings?'report':schema.claims?'fetch':schema.refuted?'verify':'search')
  }
 }else{ordinary++;kinds.push('ordinary');content=[{type:'text',text:'Fixture response '+ordinary}]}
 const msg={id:'msg_'+requests,type:'message',role:'assistant',model:b.model,content,stop_reason:stop,stop_sequence:null,usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0}}
 if(!b.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(msg));return}
 res.writeHead(200,{'Content-Type':'text/event-stream'})
 const emit=(type,x)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...x})}\n\n`)
 emit('message_start',{message:{...msg,content:[],stop_reason:null,usage:{...msg.usage,output_tokens:0}}})
 for(const [index,c]of content.entries()){
  emit('content_block_start',{index,content_block:c.type==='text'?{type:'text',text:''}:{...c,input:{}}})
  emit('content_block_delta',{index,delta:c.type==='text'?{type:'text_delta',text:c.text}:{type:'input_json_delta',partial_json:JSON.stringify(c.input)}})
  emit('content_block_stop',{index})
 }
 emit('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:5}});emit('message_stop',{});res.end()
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
process.env.ANTHROPIC_BASE_URL=`http://127.0.0.1:${server.address().port}`
const timeout=setTimeout(()=>{console.error('Fixture timed out',JSON.stringify({requests,lastKinds:kinds.slice(-15)}));process.exit(2)},60000)
let session
try{
 const sdk=await import(new URL('../../dist/sdk.mjs',import.meta.url))
 const mcp=sdk.createSdkMcpServer({type:'sdk',name:'web',tools:['web_search','web_fetch'].map(name=>sdk.tool(name,'Loopback fixture tool',{type:'object',properties:name==='web_search'?{query:{type:'string'}}:{url:{type:'string'}}},async()=>{webCalls++;return {content:[{type:'text',text:JSON.stringify({results:[{url:'https://source.example.test/fact',title:'Fixture source',text:'Fixture evidence'}]})}]}},{permissionBehavior:'allow'}))})
 session=sdk.unstable_v2_createSession({mcpServers:{web:mcp},cwd:root,model:'claude-sonnet-4-6',tools:[],settingSources:[],maxTurns:5,systemPrompt:'You are a test agent.',canUseTool:async()=>({behavior:'allow'}),thinkingConfig:{type:'disabled'}})
 const bridge=process.env.RESEARCH_BRIDGE_PATH?await import(pathToFileURL(process.env.RESEARCH_BRIDGE_PATH).href):null
 const updates=[],events=[],contract={prompt:'Wire fixture question',tools_snapshot:{research:{contract:'darb_research_v1',task_id:'research_wire',workflow:'deep-research',timeout_ms:40000,max_output_tokens:10000}}}
 const parentUuid=crypto.randomUUID()
 const stream=bridge?bridge.runResearchTurn({session,contract,input:{job_id:'wire',worker_id:'fixture'},content:contract.prompt,uuid:parentUuid,persist:async x=>updates.push(x)}):session.runBundledWorkflow(contract.prompt,{name:'deep-research',args:contract.prompt,timeoutMs:40000,maxOutputTokens:10000},{uuid:parentUuid})
 for await(const event of stream)events.push(event)
 if(bridge&&process.env.RESEARCH_SDK_FRAMES_PATH)await writeFile(process.env.RESEARCH_SDK_FRAMES_PATH,events.map(x=>JSON.stringify(x)).join('\n')+'\n')
 const result=events.findLast(x=>x.type==='result')
 assert.equal(result?.is_error,false);assert.ok(result.structured_output);assert.ok(structured>=8);assert.ok(result.usage.output_tokens>0);assert.ok(webCalls>=7);assert.ok(result.result.includes('https://source.example.test/fact'));if(bridge){assert.equal(updates.at(-1).status.status,'completed');assert.equal(updates.at(-1).status.agents[0].total_sources,1);assert.ok(events.some(e=>e.type==='assistant'&&e.message.content.some(b=>b.name==='artifacts')))}
 console.log(JSON.stringify({test:'built SDK bundled workflow loopback',requests,webCalls,kinds,result:result.structured_output,usage:result.usage,pass:true}))
 const retry=[]
 for await(const e of session.runBundledWorkflow(contract.prompt,{name:'deep-research',args:contract.prompt,timeoutMs:40000,maxOutputTokens:10000},{retryParentMessageUuid:parentUuid}))retry.push(e)
 assert.equal(retry.findLast(e=>e.type==='result')?.is_error,false)
 assert.equal(session.getMessages().filter(e=>e.type==='user'&&e.uuid===parentUuid).length,1)
 console.log(JSON.stringify({test:'built SDK workflow retry rewinds parent',pass:true}))
 session.close()
 session=sdk.unstable_v2_createSession({cwd:root,model:'claude-sonnet-4-6',tools:[],settingSources:[],maxTurns:5,systemPrompt:'You are a test agent.',thinkingConfig:{type:'disabled'}})
 const goal=[]
 for await(const event of session.sendMessage('/goal complete the loopback fixture task'))goal.push(event)
 assert.ok(goal.some(x=>x.type==='active_goal'&&x.value));assert.ok(goal.some(x=>x.type==='active_goal'&&!x.value))
 console.log(JSON.stringify({test:'built SDK goal loopback',requests,evaluations,kinds,goalEvents:goal.filter(x=>x.type==='system'||x.type==='result').map(x=>({type:x.type,subtype:x.subtype,status:x.status,goal:x.goal,is_error:x.is_error,result:x.result})),pass:evaluations>=2}))
 assert.ok(evaluations>=2)
 impossible=true
 const impossibleEvents=[]
 for await(const e of session.sendMessage('/goal do an impossible fixture task'))impossibleEvents.push(e)
 assert.ok(impossibleEvents.some(x=>x.type==='active_goal'&&!x.value))
 const status=[];for await(const e of session.sendMessage('/goal'))status.push(e)
 assert.ok(status.some(e=>e.type==='result'&&e.result.includes('No goal set')))
 console.log(JSON.stringify({test:'built SDK impossible clears goal',pass:true,evaluations}))
 session.close()
 impossible=false;unmet=true
 const bounded={cwd:root,model:'claude-sonnet-4-6',tools:[],settingSources:[],maxTurns:1,systemPrompt:'You are a test agent.',thinkingConfig:{type:'disabled'}}
 session=sdk.unstable_v2_createSession(bounded)
 for await(const e of session.sendMessage('/goal unfinished fixture')){}
 const resumeId=session.sessionId
 const transcript=(await readdir(root,{recursive:true})).find(name=>name.endsWith(resumeId+'.jsonl'))
 assert.ok(transcript,'the third SDK session must own a distinct transcript')
 const entries=(await readFile(join(root,transcript),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 assert.ok(entries.every(e=>e.sessionId===resumeId),'SDK session writes must not cross session boundaries')
 assert.ok(entries.some(e=>e.attachment?.condition==='unfinished fixture'))
 session.close()
 session=await sdk.unstable_v2_resumeSession(resumeId,bounded)
 const resumed=[];for await(const e of session.sendMessage('/goal'))resumed.push(e)
 assert.ok(resumed.some(e=>e.type==='result'&&e.result.includes('Goal active: unfinished fixture')),JSON.stringify({events:resumed,goalMarkers:session.getMessages().filter(e=>e.attachment?.type==='goal_status')}))
 const cleared=[];for await(const e of session.sendMessage('/goal clear'))cleared.push(e)
 assert.ok(cleared.some(e=>e.type==='result'&&e.result.includes('Goal cleared')))
 session.close();session=await sdk.unstable_v2_resumeSession(resumeId,bounded)
 const afterClear=[];for await(const e of session.sendMessage('/goal'))afterClear.push(e)
 assert.ok(afterClear.some(e=>e.type==='result'&&e.result.includes('No goal set')))
 console.log(JSON.stringify({test:'built SDK resume and clear remain durable',pass:true}))
 session.close()
 hold=true
 session=sdk.unstable_v2_createSession({...bounded,maxTurns:5,canUseTool:async()=>({behavior:'allow'})})
 const timed=[];for await(const e of session.runBundledWorkflow('timeout fixture',{name:'deep-research',args:'timeout fixture',timeoutMs:150}))timed.push(e)
 assert.ok(timed.some(e=>e.type==='result'&&e.is_error&&e.errors.includes('Workflow timed out')))
 console.log(JSON.stringify({test:'built SDK timeout stops actual pending HTTP',pass:true}))
 session.close();session=null;hold=false;unmet=false
 // CLI provider auto-discovery must not pick up the developer's saved profile.
 // Restrict its environment, disable discovery, and reject off-loopback HTTP.
 const guard=join(root,'network-guard.cjs')
 await writeFile(guard,`const check=u=>{const host=new URL(typeof u==='string'||u instanceof URL?u:u.url).hostname;if(host!=='127.0.0.1'&&host!=='localhost')throw Error('Fixture blocked external network: '+host)};const fetch=globalThis.fetch;globalThis.fetch=(u,o)=>{check(u);return fetch(u,o)};require('node:https').request=()=>{throw Error('Fixture blocked external HTTPS')};`)
 const childEnv={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,CLAUDE_CONFIG_DIR:root,ANTHROPIC_API_KEY:'fixture-local-only',ANTHROPIC_BASE_URL:process.env.ANTHROPIC_BASE_URL,CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',NO_PROXY:'127.0.0.1,localhost'}
 const child=spawn(process.execPath,['--require',guard,new URL('../../dist/cli.mjs',import.meta.url).pathname,'--setting-sources','','--model','claude-sonnet-4-6','--tools','','-p','/goal complete CLI fixture','--output-format','stream-json','--verbose','--max-turns','5'],{cwd:root,env:childEnv,stdio:['ignore','pipe','pipe']})
 let output='',errors='';child.stdout.on('data',x=>{output+=x});child.stderr.on('data',x=>{errors+=x})
 const exit=await new Promise(resolve=>child.on('close',resolve))
 assert.equal(exit,0,errors+'\n'+output.slice(-6000))
 const cli=output.split('\n').filter(Boolean).map(line=>JSON.parse(line))
 assert.ok(cli.some(e=>e.type==='result'&&!e.is_error))
 assert.ok(cli.some(e=>e.type==='active_goal'&&e.value))
 assert.ok(cli.some(e=>e.type==='active_goal'&&!e.value))
 console.log(JSON.stringify({test:'built CLI actual goal inference and terminal events',pass:true}))

}catch(error){console.error(error);process.exitCode=1}finally{clearTimeout(timeout);session?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
