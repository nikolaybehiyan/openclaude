import { expect, test } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile, stat, appendFile, symlink, unlink, chmod } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WorkflowRegistry } from './registry.js'
import { createWorkflowRun, recoverStoppedRunLease } from './durableJournal.js'
import { workflowInvocationKey, type WorkflowJournalRecord } from './journal.js'

const owner = {sessionId: 'session-one', agentId: 'main'}
const script = (result = '0') => `export const meta={name:'review',description:'Review'};return ${result}`
const approval = (body = script()) => new WorkflowRegistry({builtins: []}).resolve({script: body}, '/')
const key = (n: number) => workflowInvocationKey('prompt-' + n, undefined, 'previous-' + n)
const record = (n: number, result: unknown): WorkflowJournalRecord => ({type: 'result', key: key(n), agentId: 'child-' + n, result})
async function temp(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-durable-'))
  try { await run(root) } finally { await rm(root, {recursive: true, force: true}) }
}
async function options(rootDirectory: string, runId: string, extras: Record<string, any> = {}) {
  return {rootDirectory, runId, owner, approved: await approval(), ...extras}
}
async function token(root: string, runId: string) {
  return JSON.parse(await readFile(path.join(root, runId, '.lease/owner.json'), 'utf8')).token as string
}

test('persists exact approval and immutable arguments with private file modes; falsy results survive', () => temp(async root => {
  const args = {items: ['one']}
  const run = await createWorkflowRun(await options(root, 'first', {args}))
  args.items[0] = 'changed'
  expect(run.args).toEqual({items: ['one']})
  expect(Object.isFrozen((run.args as any).items)).toBe(true)
  expect(await readFile(run.scriptPath, 'utf8')).toBe(script())
  for (const file of ['approved.js', 'manifest.json', 'journal.jsonl', '.lease/owner.json']) {
    if (process.platform !== 'win32') expect((await stat(path.join(root, 'first', file))).mode & 0o777).toBe(0o600)
  }
  const values = [false, 0, '', null, [], {}]
  await Promise.all(values.map((value, i) => run.journal.append(record(i, value))))
  await Promise.all([run.close(), run.close()])
  await expect(run.journal.append(record(9, true))).rejects.toThrow('closed')
  const resumed = await createWorkflowRun(await options(root, 'second', {args: {items: ['one']}, resumeFromRunId: 'first'}))
  expect(resumed.replay).toMatchObject({reused: true, reason: 'validated-source', records: 6})
  const state = await resumed.journal.load()
  values.forEach((value, i) => expect(state.results.get(key(i))?.result).toEqual(value))
  await resumed.close()
}))
test('edited approved script can resume; changed args explicitly start with empty replay', () => temp(async root => {
  const first = await createWorkflowRun(await options(root, 'first', {args: {a: 1, b: 2}}))
  await first.journal.append(record(1, 'cached'))
  await first.close()
  const edited = await createWorkflowRun(await options(root, 'edited', {args: {b: 2, a: 1}, approved: await approval(script('42')), resumeFromRunId: 'first'}))
  expect(edited.approved.scriptBody).toBe('return 42')
  expect((await edited.journal.load()).results.get(key(1))?.result).toBe('cached')
  await edited.close()
  const changed = await createWorkflowRun(await options(root, 'changed', {args: {a: 2, b: 2}, resumeFromRunId: 'first'}))
  expect(changed.replay.reason).toBe('arguments-changed')
  expect(changed.replay.reused).toBe(false)
  expect((await changed.journal.load()).results.size).toBe(0)
  await changed.close()
}))
test('two simultaneous resumes cannot own the same source; locks last for the entire new run', () => temp(async root => {
  const first = await createWorkflowRun(await options(root, 'first'))
  await expect(createWorkflowRun(await options(root, 'early', {resumeFromRunId: 'first'}))).rejects.toThrow('active')
  await first.close()
  const attempts = await Promise.allSettled(['second', 'third'].map(async name => createWorkflowRun(await options(root, name, {resumeFromRunId: 'first'}))))
  expect(attempts.filter(item => item.status === 'fulfilled').length).toBe(1)
  const winner = attempts.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof createWorkflowRun>>>
  await expect(createWorkflowRun(await options(root, 'fourth', {resumeFromRunId: 'first'}))).rejects.toThrow('active')
  await winner.value.close()
  const next = await createWorkflowRun(await options(root, 'later', {resumeFromRunId: 'first'}))
  await next.close()
}))
test('owner, script fingerprint and run ID are checked before replay; names are not reopened', () => temp(async root => {
  const first = await createWorkflowRun(await options(root, 'first'))
  await first.close()
  await expect(createWorkflowRun(await options(root, '../escape'))).rejects.toThrow('run ID')
  await expect(createWorkflowRun(await options(root, 'other-owner', {owner: {...owner, agentId: 'other'}, resumeFromRunId: 'first'}))).rejects.toThrow('owner')
  await expect(createWorkflowRun(await options(root, 'same-session', {owner: {...owner, sessionId: 'other'}, resumeFromRunId: 'first'}))).rejects.toThrow('owner')
  await expect(createWorkflowRun(await options(root, 'first', {resumeFromRunId: 'first'}))).rejects.toThrow('unique')
  await writeFile(first.scriptPath, script('42'))
  await expect(createWorkflowRun(await options(root, 'bad-script', {resumeFromRunId: 'first'}))).rejects.toThrow('fingerprint')
  await expect(createWorkflowRun(await options(root, 'bad-approval', {approved: {...await approval(), scriptBody: 'return 42'}}))).rejects.toThrow('body mismatch')
}))
test('truncated final record is not committed; complete records recover and new appends remain valid', () => temp(async root => {
  const first = await createWorkflowRun(await options(root, 'first'))
  await first.journal.append({type: 'started', key: key(9), agentId: 'unfinished'})
  await first.journal.append(record(1, false))
  await first.close()
  const file = path.join(root, 'first', 'journal.jsonl')
  await appendFile(file, '{"sequence":2,"record":')
  const before = await readFile(file)
  const resumed = await createWorkflowRun(await options(root, 'second', {resumeFromRunId: 'first'}))
  expect(resumed.replay.discardedTailBytes).toBeGreaterThan(0)
  const state = await resumed.journal.load()
  expect(state.started.get(key(9))?.length).toBe(1)
  expect(state.results.has(key(9))).toBe(false)
  expect(state.results.get(key(1))?.result).toBe(false)
  await resumed.journal.append(record(2, 'new'))
  await resumed.close()
  expect(await readFile(file)).toEqual(before)
  const third = await createWorkflowRun(await options(root, 'third', {resumeFromRunId: 'second'}))
  expect((await third.journal.load()).results.get(key(2))?.result).toBe('new')
  await third.close()
}))
test('corrupt committed records and argument metadata are rejected, never silently skipped', () => temp(async root => {
  const first = await createWorkflowRun(await options(root, 'first'))
  await first.journal.append(record(1, 'cached'))
  await first.close()
  const file = path.join(root, 'first', 'journal.jsonl')
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace('cached', 'forged'))
  await expect(createWorkflowRun(await options(root, 'corrupt', {resumeFromRunId: 'first'}))).rejects.toThrow('integrity')
  await writeFile(file, text + 'invalid-json\n')
  await expect(createWorkflowRun(await options(root, 'corrupt-line', {resumeFromRunId: 'first'}))).rejects.toThrow('Corrupt')
  await writeFile(file, text)
  const manifestPath = path.join(root, 'first', 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.args = {present: true, value: 'forged'}
  await writeFile(manifestPath, JSON.stringify(manifest))
  await expect(createWorkflowRun(await options(root, 'args-tampered', {resumeFromRunId: 'first'}))).rejects.toThrow('arguments fingerprint')
}))
test('persistence rejects symlinked roots/runs/files and world-readable saved data', () => temp(async root => {
  const first = await createWorkflowRun(await options(root, 'first'))
  await first.close()
  const alias = root + '-alias'
  await symlink(root, alias)
  try { await expect(createWorkflowRun(await options(alias, 'bad-root'))).rejects.toThrow('symlinks') }
  finally { await unlink(alias) }
  await symlink(path.join(root, 'first'), path.join(root, 'linked-run'))
  await expect(createWorkflowRun(await options(root, 'bad-run', {resumeFromRunId: 'linked-run'}))).rejects.toThrow('symlinks')
  const journal = path.join(root, 'first', 'journal.jsonl')
  await unlink(journal)
  await symlink(first.scriptPath, journal)
  await expect(createWorkflowRun(await options(root, 'bad-file', {resumeFromRunId: 'first'}))).rejects.toThrow('symlinks')
  await unlink(journal)
  await writeFile(journal, '', {mode: 0o600})
  if (process.platform !== 'win32') {
    await chmod(first.scriptPath, 0o644)
    await expect(createWorkflowRun(await options(root, 'bad-mode', {resumeFromRunId: 'first'}))).rejects.toThrow('private')
  }
}))
test('queued records are immutable snapshots; getters and proxies never execute during persistence', () => temp(async root => {
  const run = await createWorkflowRun(await options(root, 'first'))
  const result = {value: 1}
  const operation = run.journal.append(record(1, result))
  result.value = 2
  await operation
  expect((await run.journal.load()).results.get(key(1))?.result).toEqual({value: 1})
  let calls = 0
  const hostile = {get data() {calls++; return 1}}
  await expect(run.journal.append(record(2, hostile))).rejects.toThrow('getters')
  await expect(run.journal.append(record(2, new Proxy({}, {ownKeys() {calls++; return []}})))).rejects.toThrow('plain JSON')
  await expect(run.journal.append(record(2, new Array(1_000_000_000)))).rejects.toThrow('too many')
  expect(calls).toBe(0)
  await run.close()
}))
test('crashed process lease is fail-closed until trusted stopped proof quarantines exact token', () => temp(async root => {
  const moduleURL = pathToFileURL(path.resolve(import.meta.dir, 'durableJournal.ts')).href
  const registryURL = pathToFileURL(path.resolve(import.meta.dir, 'registry.ts')).href
  const source = `import {createWorkflowRun} from ${JSON.stringify(moduleURL)};import {WorkflowRegistry} from ${JSON.stringify(registryURL)};
  const approved=await new WorkflowRegistry({builtins:[]}).resolve({script:${JSON.stringify(script())}},'/');
  const run=await createWorkflowRun({rootDirectory:${JSON.stringify(root)},runId:'crashed',owner:${JSON.stringify(owner)},approved});
  await run.journal.append(${JSON.stringify(record(1, 'durable'))});process.exit(0);`
  const child = spawn(process.execPath, ['--eval', source], {stdio: ['ignore', 'ignore', 'pipe']})
  let errors = ''
  child.stderr!.on('data', value => {errors += value})
  const exit = await new Promise<number | null>((resolve, reject) => {child.on('error', reject); child.on('exit', resolve)})
  expect({exit, errors}).toEqual({exit: 0, errors: ''})
  await expect(createWorkflowRun(await options(root, 'blocked', {resumeFromRunId: 'crashed'}))).rejects.toThrow('reconciliation')
  const expectedToken = await token(root, 'crashed')
  const before = await readFile(path.join(root, 'crashed', 'journal.jsonl'))
  const recovered = await recoverStoppedRunLease({rootDirectory: root, runId: 'crashed', owner, expectedToken,
    proveStopped: async identity => identity.token === expectedToken && child.exitCode === 0})
  expect(await readFile(path.join(recovered.quarantinedLock, 'owner.json'), 'utf8')).toContain(expectedToken)
  expect(await readFile(path.join(root, 'crashed', 'journal.jsonl'))).toEqual(before)
  const resumed = await createWorkflowRun(await options(root, 'resumed', {resumeFromRunId: 'crashed'}))
  expect((await resumed.journal.load()).results.get(key(1))?.result).toBe('durable')
  await resumed.close()
}))
test('recovery rejects active proof, wrong owner/token and a lease replaced during proof', () => temp(async root => {
  const run = await createWorkflowRun(await options(root, 'first'))
  const expectedToken = await token(root, 'first')
  const base = {rootDirectory: root, runId: 'first', owner, expectedToken}
  await expect(recoverStoppedRunLease({...base, proveStopped: async () => false})).rejects.toThrow('did not confirm')
  let calls = 0
  await expect(recoverStoppedRunLease({...base, owner: {...owner, agentId: 'intruder'}, proveStopped: async () => {calls++; return true}})).rejects.toThrow('owner')
  await expect(recoverStoppedRunLease({...base, expectedToken: 'wrong', proveStopped: async () => {calls++; return true}})).rejects.toThrow('token')
  expect(calls).toBe(0)
  const lockFile = path.join(root, 'first', '.lease/owner.json')
  const original = await readFile(lockFile)
  await expect(recoverStoppedRunLease({...base, proveStopped: async () => {
    await writeFile(lockFile, JSON.stringify({token: 'new-owner', pid: process.pid}))
    return true
  }})).rejects.toThrow('changed during recovery')
  await writeFile(lockFile, original)
  await run.close()
}))

test('real compiler, VM and dispatcher consume frozen durable approval and replay without another agent', () => temp(async root => {
  const {compileWorkflowScript} = await import('./compiler.js')
  const {executeWorkflowVM} = await import('./vmRunner.js')
  const {createWorkflowAgentDispatcher} = await import('./agentDispatcher.js')
  const approved = await approval("export const meta={name:'review',description:'Review'};return await agent(args.prompt)")
  const args = {prompt: 'review'}
  let calls = 0
  const journalErrors: string[] = []
  async function execute(run: Awaited<ReturnType<typeof createWorkflowRun>>) {
    const compiled = compileWorkflowScript(run.approved.scriptBody)
    if (!compiled.ok) throw Error(compiled.error)
    const hooks = createWorkflowAgentDispatcher({defaultModel: 'test-model', journal: run.journal, replay: await run.journal.load(),
      onProgress: () => {}, onJournalError: message => journalErrors.push(message), executeAgent: async request => {
        calls++; request.onStarted('child-one'); return {answer: 42}
      }})
    const result = await executeWorkflowVM(compiled.vmScript, hooks, {args: run.args})
    expect(result.error).toBeUndefined()
    expect(result.result).toEqual({answer: 42})
    await run.close()
  }
  const first = await createWorkflowRun(await options(root, 'first', {approved, args}))
  await execute(first)
  expect(calls).toBe(1)
  const second = await createWorkflowRun(await options(root, 'second', {approved, args, resumeFromRunId: 'first'}))
  await execute(second)
  expect(calls).toBe(1)
  expect(journalErrors).toEqual([])
}))
