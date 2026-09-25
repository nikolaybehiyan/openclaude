import type {ToolPermissionContext} from '../../Tool.js'

// 2.1.226 kn/$xs/Fxs: immutable invocation layers over CURRENT parent policy.
// This is a port primitive, not a grant API or Workflow activation switch.
export type WorkflowPermissionLayer =
  | {kind:'allowed_tools';allowedTools:readonly string[]}
  | {kind:'disallowed_tools';disallowedTools:readonly string[]}
  | {kind:'avoid_prompts'}
  | {kind:'permission_mode';mode:ToolPermissionContext['mode']}
  | {kind:'working_directory';directory:string}
  | {kind:'effort'|'model'|'max_thinking_tokens'|'flag_settings'}

export type WorkflowPermissionOwner = {
  getAppState(): {toolPermissionContext:ToolPermissionContext}
  permissionLayers?:readonly WorkflowPermissionLayer[]
}

/** The live bypass killswitch is mandatory; the caller cannot silently opt
 * into a permissive fallback. Invocation layers never edit session settings. */
export function readWorkflowPermissionContext(
  owner:WorkflowPermissionOwner,
  policy:{isBypassBlocked():boolean},
):ToolPermissionContext {
  let context=owner.getAppState().toolPermissionContext
  const layers=owner.permissionLayers
  if(!layers)return context
  const lastDirectory=layers.findLast(layer=>layer.kind==='working_directory')
  for(const layer of layers) {
    switch(layer.kind) {
      case 'allowed_tools':
        if(layer.allowedTools.length)context={...context,alwaysAllowRules:{...context.alwaysAllowRules,
          command:[...new Set([...(context.alwaysAllowRules.command??[]),...layer.allowedTools])]}}
        break
      case 'disallowed_tools':
        if(layer.disallowedTools.length)context={...context,alwaysDenyRules:{...context.alwaysDenyRules,
          command:[...new Set([...(context.alwaysDenyRules.command??[]),...layer.disallowedTools])]}}
        break
      case 'avoid_prompts':
        if(!context.shouldAvoidPermissionPrompts)context={...context,shouldAvoidPermissionPrompts:true}
        break
      case 'permission_mode':
        if(layer.mode==='bypassPermissions'&&(policy.isBypassBlocked()||!context.isBypassPermissionsModeAvailable))break
        context={...context,mode:layer.mode}
        break
      case 'working_directory':
        // Nested invocations replace only the invocation working directory;
        // explicitly configured parent directories remain available.
        if(layer===lastDirectory&&!context.additionalWorkingDirectories.has(layer.directory))context={...context,
          additionalWorkingDirectories:new Map([...context.additionalWorkingDirectories,
            [layer.directory,{path:layer.directory,source:'session'}]])}
        break
      case 'effort':case 'model':case 'max_thinking_tokens':case 'flag_settings':
        break
    }
  }
  return context
}
