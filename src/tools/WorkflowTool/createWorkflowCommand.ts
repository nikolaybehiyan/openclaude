import type {Command,PromptCommand} from '../../types/command.js'
import {isWorkflowsEnabled} from '../../utils/workflows.js'
import {getWorkflowRegistry} from './discovery.js'
import type {WorkflowDefinition} from './registry.js'

/** Public slash-command expansion from pinned 2.1.226 p3p. */
export function createWorkflowCommand(definition:WorkflowDefinition):Command&PromptCommand {
  return {type:'prompt',name:definition.name,description:definition.description,hasUserSpecifiedDescription:true,isEnabled:isWorkflowsEnabled,
    whenToUse:definition.whenToUse,progressMessage:'running dynamic workflow',contentLength:definition.script.length,
    source:definition.source==='built-in'?'bundled':definition.source,
    loadedFrom:definition.source==='built-in'?'bundled':definition.source==='plugin'?'plugin':'skills',
    ...(definition.pluginManifest&&definition.plugin?{pluginInfo:{pluginManifest:definition.pluginManifest,repository:definition.plugin}}:{}),
    kind:'workflow',disableModelInvocation:definition.disableModelInvocation,
    async getPromptForCommand(args){
      const phases=definition.phases?'\n\nPhases:\n'+definition.phases.map(phase=>`- ${phase.title}${phase.detail?`: ${phase.detail}`:''}`).join('\n'):''
      const text=args.trim(),name=JSON.stringify(definition.name)
      const input=text?`{ name: ${name}, args: ${JSON.stringify(text)} }`:`{ name: ${name} }`
      return[{type:'text',text:`Run the "${definition.name}" workflow.\n\n${definition.description}${definition.whenToUse?`\n\n${definition.whenToUse}`:''}${phases}\n\nInvoke: Workflow(${input})`}]
    },
  }
}
export async function getWorkflowCommands(cwd:string):Promise<Command[]> {
  if(!isWorkflowsEnabled())return[]
  return(await getWorkflowRegistry(cwd).list()).filter(item=>!item.hidden).map(createWorkflowCommand)
}
// Discovery reads current script bytes each time; the command registry owns its
// outer cache and invalidates it on settings/plugin changes.
export function invalidateWorkflowCache():void {}
