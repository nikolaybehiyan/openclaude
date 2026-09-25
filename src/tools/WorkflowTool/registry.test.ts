import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MAX_WORKFLOW_SCRIPT_LENGTH } from './scriptParser.js'
import { WorkflowRegistry, readWorkflowScript, workflowScriptFingerprint, type WorkflowDefinition } from './registry.js'

const script = (name = 'review', value = '0') => `export const meta={name:${JSON.stringify(name)},description:'Review',phases:[{title:'Read'}]};return ${value}`
const builtin: WorkflowDefinition = {name: 'review', description: 'Review', source: 'built-in', script: script()}
async function temp(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-registry-'))
  try { await run(root) } finally { await rm(root, {recursive: true, force: true}) }
}

test('nearest project overrides ancestors, user settings, plugins and builtins', () => temp(async root => {
  for (const [dir, value] of [['user', '1'], ['parent', '2'], ['child', '3']]) {
    await mkdir(path.join(root, dir!))
    await writeFile(path.join(root, dir!, 'review.js'), script('review', value))
  }
  const options = {builtins: [builtin], plugins: async () => [{...builtin, source: 'plugin' as const, script: script('review', '-1')}],
    userDirectory: path.join(root, 'user'), projectDirectories: [path.join(root, 'child'), path.join(root, 'parent')]}
  const resolved = await new WorkflowRegistry(options).resolve({name: 'review'}, root)
  expect(resolved.scriptBody).toBe('return 3')
  expect(resolved.source).toBe('projectSettings')
  expect(resolved.isVerbatimBuiltIn).toBe(false)
  expect((await new WorkflowRegistry({...options, projectDirectories: []}).resolve({name: 'review'}, root)).scriptBody).toBe('return 1')
  expect((await new WorkflowRegistry({...options, projectDirectories: [], userDirectory: undefined}).resolve({name: 'review'}, root)).scriptBody).toBe('return -1')
}))
test('built-in trust requires both source origin and exact script bytes', async () => {
  const registry = new WorkflowRegistry({builtins: [builtin]})
  expect((await registry.resolve({name: 'review'}, '/')).isVerbatimBuiltIn).toBe(true)
  expect((await registry.resolve({name: 'review', script: script('review', '2')}, '/')).isVerbatimBuiltIn).toBe(false)
  expect((await registry.resolve({script: builtin.script}, '/')).isVerbatimBuiltIn).toBe(false)
  const overridden = new WorkflowRegistry({builtins: [builtin], plugins: async () => [{...builtin, source: 'plugin'}]})
  expect((await overridden.resolve({name: 'review'}, '/')).isVerbatimBuiltIn).toBe(false)
})
test('approval snapshot survives file/definition edits and is deeply frozen', () => temp(async root => {
  const file = path.join(root, 'custom.js')
  await writeFile(file, script())
  const registry = new WorkflowRegistry({builtins: []})
  const approved = await registry.resolve({scriptPath: file}, root)
  await writeFile(file, script('review', '42'))
  expect(approved.scriptBody).toBe('return 0')
  expect(approved.fingerprint).toBe(workflowScriptFingerprint(script()))
  expect(Object.isFrozen(approved)).toBe(true)
  expect(Object.isFrozen(approved.meta.phases?.[0])).toBe(true)
  const snapshot = await registry.resolve({scriptPath: file, script: approved.script}, root)
  expect(snapshot.script).toBe(approved.script)
  expect((await registry.resolve({scriptPath: file}, root)).scriptBody).toBe('return 42')
}))
test('dynamic named-only mode excludes custom definitions and child path/inline/resume/remote inputs', async () => {
  let namedOnly = false
  const registry = new WorkflowRegistry({builtins: [builtin], nameOnly: () => namedOnly, plugins: async () => [{...builtin, source: 'plugin', script: script('review', '9')}]})
  expect((await registry.resolve({name: 'review'}, '/')).source).toBe('plugin')
  namedOnly = true
  expect((await registry.resolve({name: 'review'}, '/')).isVerbatimBuiltIn).toBe(true)
  for (const input of [{script: script()}, {scriptPath: '/tmp/x'}, {name: 'review', script: ''}, {name: 'review', resumeFromRunId: 'old'}, {name: 'review', remote: true}]) {
    await expect(registry.resolve(input, '/')).rejects.toThrow('named bundled')
  }
  expect((await new WorkflowRegistry({builtins: [builtin], bundledOnly: () => true, plugins: async () => {throw Error('must not load plugins')}}).list()).length).toBe(1)
})
test('discovery skips invalid metadata, non-js files and oversized UTF8 files before parsing', () => temp(async root => {
  await writeFile(path.join(root, 'good.js'), script())
  await writeFile(path.join(root, 'invalid.js'), 'throw Error("must never execute")')
  await writeFile(path.join(root, 'ignored.ts'), script('typescript'))
  await writeFile(path.join(root, 'big.js'), 'я'.repeat(MAX_WORKFLOW_SCRIPT_LENGTH / 2 + 1))
  const errors: string[] = []
  const registry = new WorkflowRegistry({builtins: [], userDirectory: root, onDiagnostic: file => errors.push(path.basename(file))})
  expect((await registry.list()).map(item => item.name)).toEqual(['review'])
  expect(errors.sort()).toEqual(['big.js', 'invalid.js'])
  await expect(registry.resolve({scriptPath: path.join(root, 'big.js')}, root)).rejects.toThrow('exceeds')
  await expect(registry.resolve({script: 'я'.repeat(MAX_WORKFLOW_SCRIPT_LENGTH / 2 + 1)}, root)).rejects.toThrow('exceeds')
}))
test('file reader rejects UNC and nonregular files; ordinary symlink discovery matches 226', () => temp(async root => {
  for (const file of ['//server/workflow.js', '\\'.repeat(2) + 'server\\workflow.js']) await expect(readWorkflowScript(file, root)).rejects.toThrow('UNC')
  await expect(readWorkflowScript(root, root)).rejects.toThrow('regular file')
  await writeFile(path.join(root, 'source'), script())
  await symlink(path.join(root, 'source'), path.join(root, 'link.js'))
  expect((await new WorkflowRegistry({builtins: [], userDirectory: root}).resolve({name: 'review'}, root)).script).toBe(script())
}))
test('missing names never fall through into inline scripts', async () => {
  await expect(new WorkflowRegistry({builtins: []}).resolve({name: 'missing', script: script()}, '/')).rejects.toThrow('not found')
})

test('name-only policy becoming active during discovery rejects a custom child resolution', async () => {
  let nameOnly = false
  const registry = new WorkflowRegistry({builtins: [builtin], nameOnly: () => nameOnly, plugins: async () => {
    nameOnly = true
    return [{...builtin, source: 'plugin', script: script('review', '7')}]
  }})
  await expect(registry.resolve({name: 'review'}, '/')).rejects.toThrow('named bundled')
})
