// Read-only extraction of two registration templates. This never launches the
// pinned executable, a workflow body, a model, or a tool. No eval in extraction.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseExpressionAt} from 'acorn';
import {runInNewContext} from 'node:vm';

export const PINNED_BINARY_SHA256 = '013a1cf17df5ff1dcc189d5d6fd3fdd5f097ddc3cd41aa9992e99805574febbe';
const JS_START = 245797944, JS_END = 269783626;
const hash = value => createHash('sha256').update(value).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));
const records = [{name:'code-review',registration:'CXp'}, {name:'deep-research',registration:'PXp'}];

export async function extractPinnedWorkflows(binary) {
  const checksum = createHash('sha256');
  for await (const chunk of fs.createReadStream(binary)) checksum.update(chunk);
  if (checksum.digest('hex') !== PINNED_BINARY_SHA256) throw Error('Pinned workflow binary SHA256 mismatch');
  const fd = fs.openSync(binary,'r'), bytes = Buffer.alloc(JS_END-JS_START);
  try { if(fs.readSync(fd,bytes,0,bytes.length,JS_START)!==bytes.length)throw Error('Truncated embedded JavaScript'); }
  finally { fs.closeSync(fd); }
  const source = bytes.toString('utf8');
  const symbols = new Map(), evaluating = new Set(), lineage = [];
  const ast = offset => parseExpressionAt(source,offset,{ecmaVersion:'latest'});
  function symbol(name) {
    if(symbols.has(name))return symbols.get(name).value;
    if(!/^[A-Za-z_$][\w$]*$/.test(name)||evaluating.has(name))throw Error('Invalid/cyclic template symbol: '+name);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const hits=[...source.matchAll(new RegExp('(?<![\\w$])'+escaped+'=(?!=)','g'))];
    if(hits.length!==1)throw Error('Initializer count drift: '+name);
    let node=ast(hits[0].index+name.length+1);
    if(node.type==='SequenceExpression')node=node.expressions[0];
    evaluating.add(name);
    const value=evaluate(node);
    evaluating.delete(name);
    const raw=source.slice(node.start,node.end);
    symbols.set(name,{value,raw});
    lineage.push({symbol:name,start:node.start,end:node.end,sourceSHA256:hash(raw)});
    return value;
  }
  function evaluate(node, locals=new Map()) {
    switch(node.type) {
      case 'Literal': if(node.regex||typeof node.value==='bigint')throw Error('Non-data literal');return node.value;
      case 'Identifier': return locals.has(node.name)?locals.get(node.name):symbol(node.name);
      case 'TemplateLiteral': return node.quasis.map((q,i)=>{
        if(q.value.cooked===null)throw Error('Invalid template escape');
        return q.value.cooked+(i<node.expressions.length?String(evaluate(node.expressions[i],locals)):'');
      }).join('');
      case 'ArrayExpression': return node.elements.map(e=>{if(!e)throw Error('Sparse template data');return evaluate(e,locals)});
      case 'ObjectExpression': {
        const result=Object.create(null);
        for(const property of node.properties) {
          if(property.type!=='Property'||property.kind!=='init'||property.method||property.computed)throw Error('Non-literal template property');
          const key=property.key.type==='Identifier'?property.key.name:evaluate(property.key,locals);
          if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsafe template property');
          result[key]=evaluate(property.value,locals);
        }
        return result;
      }
      case 'UnaryExpression': if(node.operator==='!')return !evaluate(node.argument,locals);throw Error('Unreviewed template unary expression');
      case 'MemberExpression': {
        const receiver=evaluate(node.object,locals), key=node.computed?evaluate(node.property,locals):node.property.name;
        if(key==='length'&&(Array.isArray(receiver)||typeof receiver==='string'))return receiver.length;
        if(node.computed&&typeof receiver==='string'&&Number.isSafeInteger(key)&&key>=0)return receiver[key];
        throw Error('Unreviewed template member access');
      }
      case 'CallExpression': {
        const callee=node.callee;
        if(callee.type!=='MemberExpression'||callee.computed)throw Error('Unreviewed template call');
        if(callee.object.type==='Identifier'&&callee.object.name==='JSON'&&callee.property.name==='stringify'&&node.arguments.length===1)return JSON.stringify(evaluate(node.arguments[0],locals));
        const receiver=evaluate(callee.object,locals);
        if(!Array.isArray(receiver))throw Error('Template call receiver must be an array');
        if(callee.property.name==='join'&&node.arguments.length===1)return receiver.join(evaluate(node.arguments[0],locals));
        if(callee.property.name==='map'&&node.arguments.length===1) {
          const callback=node.arguments[0];
          if(callback.type!=='ArrowFunctionExpression'||callback.async||!callback.expression||callback.params.length!==2||callback.params.some(p=>p.type!=='Identifier'))throw Error('Unreviewed template map callback');
          return receiver.map((value,index)=>evaluate(callback.body,new Map([...locals,[callback.params[0].name,value],[callback.params[1].name,index]])));
        }
        throw Error('Unreviewed template method');
      }
      default: throw Error('Unreviewed template AST node: '+node.type);
    }
  }
  const definitions=[], registrations=[];
  for(const item of records) {
    const start=source.indexOf('function '+item.registration+'(');
    if(start<0)throw Error('Missing registration '+item.registration);
    const fn=ast(start);
    if(fn.type!=='FunctionExpression'||fn.params.length||fn.body.body.length!==1)throw Error('Registration function drift');
    const call=fn.body.body[0].expression;
    if(call?.type!=='CallExpression'||call.callee.name!=='EZo'||call.arguments.length!==3||call.arguments[0].type!=='TemplateLiteral')throw Error('Registration shape drift');
    const script=evaluate(call.arguments[0]), metadata=evaluate(call.arguments[1]);
    if(metadata.name!==item.name)throw Error('Workflow name drift');
    const option=call.arguments[2];
    if(option.type!=='ObjectExpression'||option.properties.length!==1)throw Error('Workflow option drift');
    const field=option.properties[0];
    const hidden=field.key.name==='hidden'&&evaluate(field.value)===true;
    const modelGate=field.key.name==='disableModelInvocation'&&field.value.type==='Identifier'&&field.value.name==='GrS';
    if(item.name==='code-review'&&!hidden||item.name==='deep-research'&&!modelGate)throw Error('Workflow availability option drift');
    definitions.push({source:'built-in',...metadata,script,...hidden?{hidden:true}:{disableModelInvocation:true}});
    const raw=source.slice(start,fn.end);
    registrations.push({name:item.name,symbol:item.registration,start,end:fn.end,sourceSHA256:hash(raw),scriptSHA256:hash(script),scriptBytes:Buffer.byteLength(script),raw});
  }
  const gateStart=source.indexOf('function GrS('),gate=ast(gateStart),gateSource=source.slice(gateStart,gate.end);
  if(gateSource!=='function GrS(){if(nt(WrS,!1))return!1;return!0}'||symbol('WrS')!=='tengu_sorrel_avocet')throw Error('Deep research gate drift');
  // Differential reference: evaluate only the reviewed pure registration
  // template programs in an empty VM. The workflow bodies remain STRINGS.
  // Symbol ASTs have already passed the closed interpreter above; no arbitrary
  // binary/source code, file/network/process functions or workflow agents run.
  const program=[...symbols].map(([name,row])=>`const ${name}=${row.raw};`).join('\n')+'\n'+gateSource+'\n'+
    'const registrations=[];function EZo(script,meta,options){registrations.push({script,meta,hidden:options.hidden===true,gate:typeof options.disableModelInvocation===\'function\'});}\n'+
    registrations.map(row=>row.raw).join('\n')+'\nCXp();PXp();JSON.stringify(registrations)';
  const reference=JSON.parse(runInNewContext(program,Object.create(null),{timeout:1000,contextCodeGeneration:{strings:false,wasm:false}}));
  for(let i=0;i<definitions.length;i++) {
    const definition=definitions[i],actual=reference[i];
    if(actual.script!==definition.script||JSON.stringify(actual.meta)!==JSON.stringify(evaluate(ast(source.indexOf('function '+records[i].registration+'(')).body.body[0].expression.arguments[1])))throw Error('Differential registration mismatch');
    if(actual.hidden!==Boolean(definition.hidden)||actual.gate!==Boolean(definition.disableModelInvocation))throw Error('Differential availability mismatch');
  }
  const manifest={version:'2.1.226',binarySHA256:PINNED_BINARY_SHA256,embeddedJavaScript:{byteStart:JS_START,byteEnd:JS_END,sha256:hash(bytes)},
    registrations:registrations.map(({raw,...row})=>row),symbols:lineage,
    availability:{'code-review':{hidden:true},'deep-research':{disableModelInvocation:'!getFeatureValue(tengu_sorrel_avocet, false)',gateSource,sourceSHA256:hash(gateSource)}},
    extraction:'Whitelisted data AST interpreter; independently compared to isolated template registration VM; workflow bodies and binary never executed'};
  return {definitions,manifest};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,binary]=process.argv.slice(2);
  if(!['--write','--check'].includes(mode)||!binary)throw Error('Usage: extract-pinned.mjs --write|--check <verified-binary>');
  const {definitions,manifest}=await extractPinnedWorkflows(binary);
  for(const [name,value] of [['definitions.json',definitions],['lineage.json',manifest]]) {
    const text=JSON.stringify(value,null,2)+'\n',target=path.join(here,name);
    if(mode==='--write')fs.writeFileSync(target,text);
    else if(fs.readFileSync(target,'utf8')!==text)throw Error('Pinned extraction differs from '+name);
  }
  console.log(JSON.stringify({mode,workflows:manifest.registrations.map(row=>({name:row.name,sha256:row.scriptSHA256,bytes:row.scriptBytes})),differential:'PASS'}));
}
