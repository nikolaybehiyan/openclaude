import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import path from 'node:path'
import { MAX_WORKFLOW_SCRIPT_LENGTH, parseWorkflowScript, type WorkflowMeta } from './scriptParser.js'

export type WorkflowSource = 'built-in' | 'plugin' | 'userSettings' | 'projectSettings'
export type WorkflowDefinition = {
  source: WorkflowSource
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowMeta['phases']
  script: string
  filePath?: string
  hidden?: boolean
  disableModelInvocation?: boolean
}
export type WorkflowInput = { name?: string; script?: string; scriptPath?: string; resumeFromRunId?: string; remote?: boolean }
export type ResolvedWorkflow = Readonly<{
  script: string
  scriptBody: string
  meta: WorkflowMeta
  fingerprint: string
  source?: WorkflowSource
  resolvedScriptPath?: string
  scriptMatchesDefinition: boolean
  isVerbatimBuiltIn: boolean
}>
export type WorkflowRegistryOptions = {
  builtins: readonly WorkflowDefinition[]
  plugins?: () => Promise<readonly WorkflowDefinition[]>
  userDirectory?: string
  /** Nearest project directory first, as returned by the settings-dir walk. */
  projectDirectories?: readonly string[]
  nameOnly?: () => boolean
  bundledOnly?: () => boolean
  onDiagnostic?: (file: string, error: Error) => void
}

export const workflowScriptFingerprint = (script: string): string => createHash('sha256').update(script).digest('hex')

function frozenMeta(meta: WorkflowMeta): WorkflowMeta {
  if (meta.phases) {
    meta.phases.forEach(Object.freeze)
    Object.freeze(meta.phases)
  }
  return Object.freeze(meta)
}

// Bounded reads precede decoding/parsing. Opening nonblocking and checking the
// descriptor also rejects directories/devices/FIFOs instead of hanging on them.
export async function readWorkflowScript(scriptPath: string, cwd: string): Promise<{script: string; path: string}> {
  if (/^(?:\\\\|\/\/)/.test(scriptPath)) throw Error('UNC paths are not allowed for workflow scriptPath')
  const file = path.resolve(cwd, scriptPath)
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw Error('Workflow script must be a regular file')
    if (stat.size > MAX_WORKFLOW_SCRIPT_LENGTH) throw Error(`Workflow script exceeds ${MAX_WORKFLOW_SCRIPT_LENGTH} bytes`)
    const bytes = Buffer.alloc(MAX_WORKFLOW_SCRIPT_LENGTH + 1)
    let length = 0
    while (length < bytes.length) {
      const next = await handle.read(bytes, length, bytes.length - length, null)
      if (!next.bytesRead) break
      length += next.bytesRead
    }
    if (length > MAX_WORKFLOW_SCRIPT_LENGTH) throw Error(`Workflow script exceeds ${MAX_WORKFLOW_SCRIPT_LENGTH} bytes`)
    return {script: bytes.subarray(0, length).toString('utf8'), path: file}
  } finally { await handle.close() }
}

function validate(script: string) {
  if (Buffer.byteLength(script) > MAX_WORKFLOW_SCRIPT_LENGTH) throw Error(`Workflow script exceeds ${MAX_WORKFLOW_SCRIPT_LENGTH} bytes`)
  const parsed = parseWorkflowScript(script)
  if ('error' in parsed) throw Error(parsed.error)
  return parsed
}

// No cached mutable scripts: resolve once for approval and pass the frozen
// result directly to the runner. A later file/name edit requires fresh approval.
export class WorkflowRegistry {
  private readonly builtins: readonly WorkflowDefinition[]
  constructor(private readonly options: WorkflowRegistryOptions) {
    this.builtins = Object.freeze(options.builtins.map(definition => {
      const parsed = validate(definition.script)
      if (definition.source !== 'built-in' || parsed.meta.name !== definition.name) throw Error('Invalid built-in workflow definition')
      const meta = frozenMeta(parsed.meta)
      return Object.freeze({...definition, description: meta.description, whenToUse: meta.whenToUse, phases: meta.phases})
    }))
  }

  private async directory(directory: string, source: WorkflowSource): Promise<WorkflowDefinition[]> {
    let entries
    try { entries = await readdir(directory, {withFileTypes: true}) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.onDiagnostic?.(directory, error as Error)
      return []
    }
    const result: WorkflowDefinition[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith('.js')) continue
      const file = path.resolve(directory, entry.name)
      try {
        const {script} = await readWorkflowScript(file, directory)
        const {meta} = validate(script)
        frozenMeta(meta)
        result.push(Object.freeze({source, name: meta.name, description: meta.description, whenToUse: meta.whenToUse, phases: meta.phases, script, filePath: file}))
      } catch (error) { this.options.onDiagnostic?.(file, error as Error) }
    }
    return result
  }

  async list(): Promise<readonly WorkflowDefinition[]> {
    if (this.options.nameOnly?.() || this.options.bundledOnly?.()) return [...this.builtins]
    const definitions = new Map(this.builtins.map(item => [item.name, item]))
    for (const item of await this.options.plugins?.() ?? []) {
      try {
        const {meta} = validate(item.script)
        if (item.source !== 'plugin' || item.name !== meta.name) throw Error('Invalid plugin workflow definition')
        frozenMeta(meta)
        definitions.set(item.name, Object.freeze({...item, description: meta.description, whenToUse: meta.whenToUse, phases: meta.phases}))
      } catch (error) { this.options.onDiagnostic?.(item.filePath ?? item.name, error as Error) }
    }
    if (this.options.userDirectory) for (const item of await this.directory(this.options.userDirectory, 'userSettings')) definitions.set(item.name, item)
    // Local definitions override plugins/builtins, nearest project wins user
    // and ancestor settings. Directory discovery itself belongs to settings.
    for (const directory of [...this.options.projectDirectories ?? []].reverse()) {
      for (const item of await this.directory(directory, 'projectSettings')) definitions.set(item.name, item)
    }
    return [...definitions.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async resolve(input: WorkflowInput, cwd: string): Promise<ResolvedWorkflow> {
    const nameOnly = this.options.nameOnly?.() ?? false
    if (nameOnly && (!input.name || input.script !== undefined || input.scriptPath !== undefined || input.resumeFromRunId !== undefined || input.remote)) {
      throw Error('This session restricts workflows to named bundled workflows (CLAUDE_WORKFLOW_NAME_ONLY)')
    }
    let script: string, source: WorkflowSource | undefined, resolvedScriptPath: string | undefined
    let scriptMatchesDefinition = false
    if (input.scriptPath) {
      // A permission-approved snapshot may carry both script and its original
      // path. The bytes win; never reopen that path after approval.
      if (/^(?:\\\\|\/\/)/.test(input.scriptPath)) throw Error('UNC paths are not allowed for workflow scriptPath')
      if (input.script !== undefined) { script = input.script; resolvedScriptPath = path.resolve(cwd, input.scriptPath) }
      else { const read = await readWorkflowScript(input.scriptPath, cwd); script = read.script; resolvedScriptPath = read.path }
      if (this.builtins.some(item => item.script === script)) { source = 'built-in'; scriptMatchesDefinition = true }
    } else if (input.name) {
      const definitions = await this.list()
      const definition = definitions.find(item => item.name === input.name)
      if (!definition) throw Error(`Workflow "${input.name}" not found. Available: ${definitions.map(item => item.name).join(', ') || '(none)'}`)
      script = input.script ?? definition.script
      source = definition.source
      resolvedScriptPath = definition.filePath
      scriptMatchesDefinition = script === definition.script
    } else if (input.script !== undefined) script = input.script
    else throw Error('Must provide script, name, or scriptPath')
    if (this.options.nameOnly?.() && (!input.name || input.script !== undefined || input.scriptPath !== undefined || input.resumeFromRunId !== undefined || input.remote || source !== 'built-in' || !scriptMatchesDefinition)) {
      throw Error('This session restricts workflows to named bundled workflows (CLAUDE_WORKFLOW_NAME_ONLY)')
    }
    const parsed = validate(script)
    return Object.freeze({script, scriptBody: parsed.scriptBody, meta: frozenMeta(parsed.meta), source, resolvedScriptPath,
      fingerprint: workflowScriptFingerprint(script), scriptMatchesDefinition,
      isVerbatimBuiltIn: source === 'built-in' && scriptMatchesDefinition && this.builtins.some(item => item.script === script)})
  }
}
