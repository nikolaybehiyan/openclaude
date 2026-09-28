// Built CLI regression: a slow/unavailable count endpoint must not be contacted
// by background reports. The conversation and control protocol are real; only
// inference is a local fixture. No user profile or external provider is used.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const baseline = process.argv.includes('--baseline')
const root = await mkdtemp(join(tmpdir(), 'darb-context-regression-'))
const cwd = join(root, 'workspace'), config = join(root, 'config')
await mkdir(cwd); await mkdir(config)
await writeFile(join(cwd, 'CLAUDE.md'), 'Fixture instructions: answer each message briefly.\n')
let countCalls = 0, inferenceCalls = 0, child, stderr = '', buffer = ''
const frames = [], waiters = new Set(), pendingTimers = new Set()
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  if (req.url?.includes('/count_tokens')) {
    countCalls++
    const timer = setTimeout(() => {
      pendingTimers.delete(timer)
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fixture count unavailable' } }))
    }, 800)
    pendingTimers.add(timer)
    return
  }
  if (!req.url?.startsWith('/v1/messages')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return
  }
  inferenceCalls++
  const message = { id: 'fixture-' + inferenceCalls, type: 'message', role: 'assistant', model: body.model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1234, output_tokens: 0, cache_creation_input_tokens: 50, cache_read_input_tokens: 100 } }
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'CONTEXT_OK' }], stop_reason: 'end_turn' })); return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  event('message_start', { message })
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'CONTEXT_OK' } })
  event('content_block_stop', { index: 0 })
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } })
  event('message_stop', {}); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
function waitFor(predicate, timeout = 20000) {
  const existing = frames.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const callback = frame => { if (predicate(frame)) { clearTimeout(timer); waiters.delete(callback); resolve(frame) } }
    const timer = setTimeout(() => { waiters.delete(callback); reject(Error('CLI fixture timeout: ' + stderr.slice(-2000))) }, timeout)
    waiters.add(callback)
  })
}
const send = value => child.stdin.write(JSON.stringify(value) + '\n')
const control = (id, request) => send({ type: 'control_request', request_id: id, request })
const user = text => send({ type: 'user', session_id: 'fixture', parent_tool_use_id: null, message: { role: 'user', content: text } })
try {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(DARB_|ANTHROPIC_|CLAUDE_|OPENCLAUDE_|OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/.test(key)) delete env[key]
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'sk-ant-local-fixture',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ENABLE_TOOL_SEARCH: 'auto' })
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.mjs')
  child = spawn(process.execPath, [cli, '-p', '--provider', 'anthropic', '--model', 'claude-sonnet-4-6',
    '--tools', 'Read', '--setting-sources', 'project', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000) })
  child.stdout.on('data', data => {
    buffer += data
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line) continue
      const frame = JSON.parse(line); frames.push(frame)
      for (const callback of waiters) callback(frame)
    }
  })
  control('init', { subtype: 'initialize' })
  await waitFor(f => f.type === 'control_response' && f.response.request_id === 'init')
  user('First fixture turn. Reply CONTEXT_OK, without tools.')
  await waitFor(f => f.type === 'result')
  const started = performance.now()
  control('context-1', { subtype: 'get_context_usage' })
  control('context-2', { subtype: 'get_context_usage' })
  user('Second fixture turn. Reply CONTEXT_OK, without tools.')
  const reports = await Promise.all(['context-1', 'context-2'].map(id =>
    waitFor(f => f.type === 'control_response' && f.response.request_id === id)))
  const elapsedMs = Math.round(performance.now() - started)
  await waitFor(f => f.type === 'result' && frames.filter(x => x.type === 'result').length >= 2)
  for (const report of reports) {
    assert.equal(report.response.subtype, 'success', JSON.stringify(report))
    assert.equal(report.response.response.totalTokens, 1384, 'Preserve actual input/cache usage')
    assert.ok(report.response.response.categories.some(c => c.name === 'System prompt' && c.tokens > 0))
  }
  if (baseline) assert.ok(countCalls > 0, 'Baseline must reproduce remote count fanout')
  else { assert.equal(countCalls, 0); assert.equal(inferenceCalls, 2, 'Background must not invoke a fallback model'); assert.ok(elapsedMs < 3000) }
  console.log(JSON.stringify({ status: 'pass', baseline, countCalls, inferenceCalls, reports: reports.length, elapsedMs, actualInputTokens: 1384 }))
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
  for (const timer of pendingTimers) clearTimeout(timer)
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
