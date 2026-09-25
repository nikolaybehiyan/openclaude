import { createHash } from 'node:crypto'
import definitions from './definitions.json'
import lineage from './lineage.json'
import { parseWorkflowScript } from '../scriptParser.js'
import type { WorkflowDefinition } from '../registry.js'

let initialized: readonly WorkflowDefinition[] | undefined

/** Register the exact two inert 2.1.226 definitions. This does not enable the
 * Workflow tool, execute a script, or grant agent/tool permissions. */
export function initBundledWorkflows(): readonly WorkflowDefinition[] {
  if (initialized) return initialized
  const result: WorkflowDefinition[] = []
  for (const definition of definitions) {
    const expected = lineage.registrations.find(item => item.name === definition.name)
    if (!expected || createHash('sha256').update(definition.script).digest('hex') !== expected.scriptSHA256 || Buffer.byteLength(definition.script) !== expected.scriptBytes) {
      throw Error('Bundled workflow lineage mismatch: ' + definition.name)
    }
    const parsed = parseWorkflowScript(definition.script)
    if ('error' in parsed) throw Error('Invalid bundled workflow: ' + parsed.error)
    const meta = {name: parsed.meta.name, description: parsed.meta.description, whenToUse: parsed.meta.whenToUse, phases: parsed.meta.phases}
    if (JSON.stringify(meta) !== JSON.stringify({name: definition.name, description: definition.description, whenToUse: definition.whenToUse, phases: definition.phases})) throw Error('Bundled workflow metadata mismatch')
    if (meta.phases) { meta.phases.forEach(Object.freeze); Object.freeze(meta.phases) }
    result.push(Object.freeze({source: 'built-in', ...meta, script: definition.script,
      ...(definition.name === 'code-review' ? {hidden: true} : {disableModelInvocation: true})}))
  }
  if (result.length !== 2 || result[0]?.name !== 'code-review' || result[1]?.name !== 'deep-research') throw Error('Bundled workflow registry drift')
  initialized = Object.freeze(result)
  return initialized
}

/** The owner supplies the existing tengu_sorrel_avocet gate (default false),
 * matching GrS in 2.1.226. Availability remains separate from exact script
 * bytes/trust. The tool owner also enforces hidden/disableModelInvocation. */
export function getBundledWorkflows(options: {deepResearchEnabled?: boolean} = {}): readonly WorkflowDefinition[] {
  return Object.freeze(initBundledWorkflows().map(definition => definition.name === 'deep-research'
    ? Object.freeze({...definition, disableModelInvocation: options.deepResearchEnabled !== true})
    : definition))
}
