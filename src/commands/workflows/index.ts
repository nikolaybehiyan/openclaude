import type {Command} from '../../types/command.js'
import {isWorkflowsEnabled} from '../../utils/workflows.js'
const workflows={type:'local-jsx',name:'workflows',description:'Browse running and completed workflows',
  isEnabled:isWorkflowsEnabled,immediate:true,load:()=>import('./workflows.js')} satisfies Command
export default workflows
