import {dirname,join} from 'node:path'
import {getFeatureValue_CACHED_MAY_BE_STALE} from '../../services/analytics/growthbook.js'
import {getCwd} from '../../utils/cwd.js'
import {getClaudeConfigHomeDir,isEnvTruthy} from '../../utils/envUtils.js'
import {logError} from '../../utils/log.js'
import {getEnabledSettingSources} from '../../utils/settings/constants.js'
import {getBundledWorkflows} from './bundled/index.js'
import {loadPluginWorkflows} from './pluginWorkflows.js'
import {WorkflowRegistry} from './registry.js'

export function getWorkflowRegistry(cwd=getCwd()):WorkflowRegistry {
  const enabled=getEnabledSettingSources(),projectDirectories:string[]=[]
  if(enabled.includes('projectSettings'))for(let current=cwd;;) {
    projectDirectories.push(join(current,'.claude','workflows'))
    const parent=dirname(current);if(parent===current)break;current=parent
  }
  return new WorkflowRegistry({
    builtins:getBundledWorkflows({deepResearchEnabled:getFeatureValue_CACHED_MAY_BE_STALE('tengu_sorrel_avocet',false)}),
    plugins:loadPluginWorkflows,
    userDirectory:enabled.includes('userSettings')?join(getClaudeConfigHomeDir(),'workflows'):undefined,
    projectDirectories,nameOnly:()=>isEnvTruthy(process.env.CLAUDE_WORKFLOW_NAME_ONLY),
    onDiagnostic:(_file,error)=>logError(error),
  })
}
