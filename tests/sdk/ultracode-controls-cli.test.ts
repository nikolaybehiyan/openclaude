import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Actual built CLI + native JSON controls. No inference is requested, no real
// account or credentials are inherited. This is not an agent/workflow E2E.
const cli = process.env.OPENCLAUDE_TEST_CLI
type Controls = { read: () => Promise<any>; apply: (settings: Record<string, unknown>) => Promise<any> }
async function withCLI(settings: Record<string, unknown>, verify: (controls: Controls) => Promise<void>) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'darb-ultracode-controls-')))
  const config = join(temporary, 'config')
  await mkdir(config)
  let messageCalls = 0
  const fixture = Bun.serve({hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname.endsWith('/messages')) messageCalls++
    return Response.json({error: {type: 'invalid_request_error', message: 'No inference allowed in control fixture'}}, {status: 400})
  }})
  const executable = resolve(cli!)
  const child = Bun.spawn([...(executable.endsWith('.mjs') ? [process.execPath, executable] : [executable]),
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--model', 'claude-sonnet-5', '--settings', JSON.stringify(settings)], {
    cwd: temporary,
    env: {PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir(), CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', ANTHROPIC_API_KEY: 'sk-local-control-fixture',
      ANTHROPIC_BASE_URL: fixture.url.origin, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1'},
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const errors = new Response(child.stderr).text()
  const frames: any[] = []
  const reader = (async () => {
    let buffer = ''
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk)
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (line.startsWith('{')) frames.push(JSON.parse(line))
      }
    }
  })()
  let sequence = 0
  async function control(request: any) {
    const id = `controls-${++sequence}`
    child.stdin.write(JSON.stringify({type: 'control_request', request_id: id, request}) + '\n')
    const until = Date.now() + 15000
    while (Date.now() < until) {
      const frame = frames.find(frame => frame.type === 'control_response' && frame.response?.request_id === id)
      if (frame) { expect(frame.response.subtype).toBe('success'); return frame.response.response }
      if (child.exitCode !== null) throw Error(`CLI exited ${child.exitCode}: ${(await errors).slice(-1000)}`)
      await Bun.sleep(10)
    }
    throw Error(`Control ${request.subtype} timed out`)
  }
  const read = () => control({subtype: 'get_settings'})
  const apply = (settings: any) => control({subtype: 'apply_flag_settings', settings})
  try {
    await control({subtype: 'initialize'})
    await verify({read, apply})
    expect(messageCalls).toBe(0)
  } finally {
    child.stdin.end(); child.kill()
    await Promise.race([child.exited, Bun.sleep(500)])
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited; await reader; await errors
    fixture.stop(true)
    await rm(temporary, {recursive: true, force: true})
  }
}

test.skipIf(!cli)('built CLI consumes Ultracode flags and clears effort before ACK', async () => {
  await withCLI({}, async ({read, apply}) => {
    const baseline = await read()
    expect(baseline.applied.effort).not.toBe('xhigh')
    await apply({effortLevel: 'high'})
    expect((await read()).applied.effort).toBe('high')
    await apply({effortLevel: 'low', ultracode: true})
    const on = await read()
    expect(on.effective.ultracode).toBe(true)
    expect(on.applied.effort).toBe('xhigh')
    // The executor is not shipped yet: never report a working Ultracode
    // merely because the protocol accepted the separate raw session flag.
    expect(on.applied.ultracode).toBe(false)
    await apply({effortLevel: 'low'})
    expect((await read()).applied.effort).toBe('low')
    await apply({effortLevel: null, ultracode: false})
    const reset = await read()
    expect(reset.applied.effort).toBe(baseline.applied.effort)
    expect(reset.applied.ultracode).toBe(false)
    await apply({effortLevel: 'max'})
    expect((await read()).applied.effort).toBe('max')
    await apply({effortLevel: 'ultracode'})
    expect((await read()).applied.effort).toBe('xhigh')
  })
}, 45000)

test.skipIf(!cli)('built CLI restart restores cleared effort without replaying Ultracode enable', async () => {
  let defaultEffort: unknown
  await withCLI({}, async ({read}) => { defaultEffort = (await read()).applied.effort })
  const checkpoint = {version: 1, effort: null, ultracode: true}
  await withCLI({ultracode: true, darbNativeReasoningRestore: checkpoint}, async ({read, apply}) => {
    const restored = await read()
    expect(restored.effective.ultracode).toBe(true)
    expect(restored.applied.effort).toBe(defaultEffort)
    expect(restored.applied.effort).not.toBe('xhigh')
    await apply({effortLevel: 'low'})
    expect((await read()).applied.effort).toBe('low')
    // Even a later settings refresh cannot replay the startup checkpoint.
    await apply({darbNativeReasoningRestore: {version: 1, effort: 'max', ultracode: true}})
    expect((await read()).applied.effort).toBe('low')
    await apply({ultracode: true})
    expect((await read()).applied.effort).toBe('xhigh')
  })
}, 45000)

test.skipIf(!cli)('built CLI refuses malformed launch checkpoint before accepting controls', async () => {
  await expect(withCLI({darbNativeReasoningRestore: {version: 2, effort: null, ultracode: true}}, async () => {
    throw Error('Malformed checkpoint must not initialize')
  })).rejects.toThrow('Invalid Darb native reasoning restore state')
}, 45000)
