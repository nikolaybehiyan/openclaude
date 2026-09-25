import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parse } from 'acorn'
import { simple } from 'acorn-walk'
import { getBundledWorkflows, initBundledWorkflows } from './index.js'
import { extractPinnedWorkflows, PINNED_BINARY_SHA256 } from './extract-pinned.mjs'
import definitions from './definitions.json'
import lineage from './lineage.json'
import { parseWorkflowScript } from '../scriptParser.js'
import { compileWorkflowScript } from '../compiler.js'
import { WorkflowRegistry } from '../registry.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
test('exact pinned scripts and parsed metadata compile without running their bodies', () => {
  const builtin = getBundledWorkflows()
  expect(builtin.map(row => row.name)).toEqual(['code-review', 'deep-research'])
  expect(lineage.version).toBe('2.1.226')
  expect(lineage.binarySHA256).toBe(PINNED_BINARY_SHA256)
  for (const definition of builtin) {
    const expected = lineage.registrations.find(row => row.name === definition.name)!
    expect(hash(definition.script)).toBe(expected.scriptSHA256)
    expect(Buffer.byteLength(definition.script)).toBe(expected.scriptBytes)
    const parsed = parseWorkflowScript(definition.script)
    if ('error' in parsed) throw Error(parsed.error)
    expect(parsed.meta.name).toBe(definition.name)
    expect(parsed.meta.phases).toEqual(definition.phases)
    expect(parsed.meta.phases?.length).toBe(5)
    expect(compileWorkflowScript(parsed.scriptBody).ok).toBe(true)
  }
})
test('actual hidden and default-off model-invocation policies are retained without altering scripts', () => {
  const first = initBundledWorkflows()
  expect(initBundledWorkflows()).toBe(first)
  expect(Object.isFrozen(first)).toBe(true)
  expect(Object.isFrozen(first[0]?.phases?.[0])).toBe(true)
  const disabled = getBundledWorkflows(), enabled = getBundledWorkflows({deepResearchEnabled: true})
  expect(disabled[0]?.hidden).toBe(true)
  expect(disabled[1]?.disableModelInvocation).toBe(true)
  expect(enabled[1]?.disableModelInvocation).toBe(false)
  expect(getBundledWorkflows()[1]?.disableModelInvocation).toBe(true)
  expect(enabled.map(row => row.script)).toEqual(disabled.map(row => row.script))
})
test('registry resolves exact bundled origin but cannot transfer trust to an inline copy', async () => {
  const builtins = getBundledWorkflows()
  const registry = new WorkflowRegistry({builtins})
  for (const definition of builtins) {
    expect((await registry.resolve({name: definition.name}, '/')).isVerbatimBuiltIn).toBe(true)
    expect((await registry.resolve({script: definition.script}, '/')).isVerbatimBuiltIn).toBe(false)
  }
})
test('actual scripts use local hooks and inherit model: no remote/self-nesting or direct host calls added', () => {
  for (const definition of definitions) {
    const ast = parse(definition.script, {ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true})
    const counts = new Map<string, number>(), forbidden: string[] = [], overrides: string[] = []
    simple(ast, {
      CallExpression(node) {
        const callee = node.callee
        const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' ? `${callee.object.name}.${callee.property.name}` : undefined
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
        if (name && ['workflow', 'fetch', 'require', 'eval', 'Function', 'Date.now', 'Math.random'].includes(name)) forbidden.push(name)
      },
      ImportExpression() { forbidden.push('import') },
      Property(node) {
        const key = node.key.type === 'Identifier' ? node.key.name : node.key.type === 'Literal' ? node.key.value : undefined
        if (typeof key === 'string' && ['model', 'effort', 'isolation', 'agentType'].includes(key)) overrides.push(key)
      },
    })
    expect(forbidden).toEqual([])
    expect(overrides).toEqual([])
    expect(counts.get('agent')).toBe(5)
    expect(counts.get('phase')).toBe(3)
    expect(counts.get('parallel')).toBe(definition.name === 'code-review' ? 2 : 3)
    expect(counts.get('pipeline') ?? 0).toBe(definition.name === 'code-review' ? 0 : 1)
  }
})
test('extraction refuses any unpinned executable before interpreting source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-extraction-'))
  try {
    const file = path.join(root, 'untrusted')
    await writeFile(file, '#!/bin/sh\nexit 99\n', {mode: 0o700})
    await expect(extractPinnedWorkflows(file)).rejects.toThrow('SHA256 mismatch')
  } finally { await rm(root, {recursive: true, force: true}) }
})
