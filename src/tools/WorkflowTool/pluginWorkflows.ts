import {readdir,realpath,stat} from 'node:fs/promises'
import path from 'node:path'
import type {LoadedPlugin} from '../../types/plugin.js'
import {parseWorkflowScript} from './scriptParser.js'
import {readWorkflowScript,type WorkflowDefinition} from './registry.js'

/** 2.1.226 plugin workflow contract: enabled plugins, namespace, explicit paths
 * replace the default directory, flat .js discovery, deduplicated real paths. */
export async function discoverPluginWorkflows(plugins:readonly LoadedPlugin[],onError:(file:string,error:Error)=>void):Promise<WorkflowDefinition[]> {
  const definitions:WorkflowDefinition[]=[]
  for(const plugin of plugins) {
    if(plugin.enabled===false)continue
    const seen=new Set<string>()
    const declared=plugin.manifest.experimental?.workflows??plugin.manifest.workflows
    const paths=declared===undefined?['./workflows']:
      Array.isArray(declared)?declared:[declared]
    let root:string
    try{root=await realpath(plugin.path)}catch(error){onError(plugin.path,error as Error);continue}
    async function file(candidate:string) {
      const resolved=await realpath(candidate)
      const relative=path.relative(root,resolved)
      if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Workflow path escapes plugin root')
      if(seen.has(resolved))return
      seen.add(resolved)
      const {script}=await readWorkflowScript(resolved,root)
      const parsed=parseWorkflowScript(script)
      if('error'in parsed)throw Error(parsed.error)
      definitions.push({source:'plugin',plugin:plugin.source,pluginName:plugin.name,pluginManifest:plugin.manifest,
        name:`${plugin.name}:${parsed.meta.name}`,description:parsed.meta.description,whenToUse:parsed.meta.whenToUse,
        phases:parsed.meta.phases,script,filePath:resolved})
    }
    for(const relative of paths) {
      const candidate=path.resolve(root,relative)
      try {
        if(!relative.startsWith('./'))throw Error('Workflow path must be relative to plugin root')
        const resolved=await realpath(candidate),within=path.relative(root,resolved)
        if(within==='..'||within.startsWith('..'+path.sep)||path.isAbsolute(within))throw Error('Workflow path escapes plugin root')
        const info=await stat(resolved)
        if(info.isDirectory())for(const entry of (await readdir(resolved,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
          if(!(entry.isFile()||entry.isSymbolicLink())||!entry.name.endsWith('.js'))continue
          const child=path.join(resolved,entry.name)
          try{await file(child)}catch(error){onError(child,error as Error)}
        }
        else if(info.isFile()&&resolved.endsWith('.js'))await file(resolved)
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')onError(candidate,error as Error)}
    }
  }
  return definitions
}

export async function loadPluginWorkflows():Promise<WorkflowDefinition[]> {
  const [{loadAllPluginsCacheOnly},{logError}]=await Promise.all([import('../../utils/plugins/pluginLoader.js'),import('../../utils/log.js')])
  const {enabled}=await loadAllPluginsCacheOnly()
  return discoverPluginWorkflows(enabled,(_file,error)=>logError(error))
}
