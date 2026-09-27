import {mkdir,open,realpath} from 'node:fs/promises'
import {constants} from 'node:fs'
import path from 'node:path'
import {parse} from 'acorn'
import {parseWorkflowScript} from './scriptParser.js'
import {validateReviewedWorkflow} from './approval.js'

export class WorkflowAlreadyExistsError extends Error {}
export async function saveWorkflow(options:{name:string;script:string;directory:string;overwrite?:boolean}):Promise<{path:string;name:string}> {
  const name=options.name.trim()
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name))throw Error('Use 1–80 letters, digits, hyphens or underscores for the workflow name')
  const error=validateReviewedWorkflow(options.script);if(error)throw Error(error)
  // Replace only the metadata name literal. Never stringify/rewrite executable
  // statements or evaluate any part of a saved workflow.
  const ast=parse(options.script,{ecmaVersion:'latest',sourceType:'module',allowAwaitOutsideFunction:true,allowReturnOutsideFunction:true}) as any
  const property=ast.body[0].declaration.declarations[0].init.properties.findLast((item:any)=>(item.key.name??item.key.value)==='name')
  const script=options.script.slice(0,property.value.start)+JSON.stringify(name)+options.script.slice(property.value.end)
  const checked=parseWorkflowScript(script);if('error'in checked)throw Error(checked.error)
  await mkdir(options.directory,{recursive:true,mode:0o700})
  const directory=await realpath(options.directory),file=path.join(directory,`${name}.js`)
  let handle
  try{handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK|(options.overwrite?0:constants.O_EXCL),0o600)}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new WorkflowAlreadyExistsError(`${file} already exists`);throw error}
  try {
    const stat=await handle.stat()
    if(!stat.isFile()||stat.nlink!==1)throw Error('Workflow destination must be a regular file, not a link')
    await handle.truncate(0);await handle.writeFile(script);await handle.sync()
  }finally{await handle.close()}
  return{path:file,name}
}
