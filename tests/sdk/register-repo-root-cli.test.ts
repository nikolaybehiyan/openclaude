import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// Opt-in integration test against an actual built CLI (or the local 2.1.221
// binary). Inference is a loopback-only fixture: no real account credentials
// or production services, and all model output is a fixed local test response.
const cli = process.env.OPENCLAUDE_TEST_CLI

test.skipIf(!cli)('built CLI loads registered repo instructions, skills, plugins and MCP through SDK', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'repo-root-sdk-')))
  const workspace = join(temporary, 'workspace')
  const repository = join(workspace, 'repo')
  await mkdir(repository, { recursive: true })
  await mkdir(join(temporary, 'config'))
  await mkdir(join(repository, '.claude', 'skills', 'repo-sdk-skill'), { recursive: true })
  await writeFile(join(repository, 'CLAUDE.md'), 'REPO_ROOT_MEMORY_SENTINEL: Follow repository-specific test instructions.\n')
  await writeFile(join(repository, '.claude', 'skills', 'repo-sdk-skill', 'SKILL.md'),
    '---\nname: repo-sdk-skill\ndescription: REPO_ROOT_SKILL_SENTINEL protocol fixture skill\n---\nOnly used by the offline SDK test.\n')
  const marketplace = join(temporary, 'marketplace')
  const plugin = join(marketplace, 'plugins', 'repo-sdk-plugin')
  await mkdir(join(marketplace, '.claude-plugin'), { recursive: true })
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true })
  await mkdir(join(plugin, 'skills', 'plugin-sdk-skill'), { recursive: true })
  await writeFile(join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'repo-sdk-market', owner: { name: 'Local SDK test' },
    plugins: [{ name: 'repo-sdk-plugin', source: './plugins/repo-sdk-plugin' }],
  }))
  await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'repo-sdk-plugin', version: '1.0.0', description: 'Local protocol fixture',
  }))
  await writeFile(join(plugin, 'skills', 'plugin-sdk-skill', 'SKILL.md'),
    '---\nname: plugin-sdk-skill\ndescription: REPO_ROOT_PLUGIN_SENTINEL local plugin skill\n---\nOnly used by the offline SDK test.\n')
  await writeFile(join(repository, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'repo-sdk-plugin@repo-sdk-market': true },
  }))
  // The administrator declares the catalog in a trusted settings source.
  // The newly registered repo only enables an already configured plugin;
  // it does not grant itself authority to introduce a new marketplace.
  const administratorSettings = JSON.stringify({
    extraKnownMarketplaces: { 'repo-sdk-market': { source: { source: 'directory', path: marketplace } } },
  })
  const mcpMethods: string[] = []
  const mcpServer = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const message = await request.json() as any
      mcpMethods.push(message.method)
      if (message.id === undefined) return new Response(null, { status: 202 })
      let result: unknown = {}
      if (message.method === 'initialize') {
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'repo-sdk-mcp', version: '1.0.0' },
        }
      } else if (message.method === 'tools/list') {
        result = { tools: [{
          name: 'repo_probe', description: 'Local repository MCP fixture',
          inputSchema: { type: 'object', properties: {} },
        }] }
      }
      return Response.json({ jsonrpc: '2.0', id: message.id, result })
    },
  })
  await writeFile(join(plugin, '.mcp.json'), JSON.stringify({
    mcpServers: { 'repo-sdk-mcp': { type: 'http', url: new URL('/mcp', mcpServer.url).href } },
  }))
  const inferenceRequests: any[] = []
  const inference = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 200 })
      const body = await request.json()
      inferenceRequests.push(body)
      const message = {
        id: 'msg_register_repo_test', type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      }
      const events = [
        { type: 'message_start', message },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sdk-test-ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  const executable = resolve(cli!)
  const command = executable.endsWith('.mjs')
    ? [process.execPath, executable]
    : [executable]
  const child = Bun.spawn([...command,
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--no-session-persistence', '--model', 'claude-sonnet-4-6',
    '--debug-file', join(temporary, 'debug.log'),
    '--settings', administratorSettings,
  ], {
    cwd: workspace,
    // Allowlist process environment: never inherit a user's model, remote,
    // GitHub, MCP, or provider credentials into a protocol-only fixture.
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      CLAUDE_CONFIG_DIR: join(temporary, 'config'),
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      ANTHROPIC_API_KEY: 'sk-test-register-repo-protocol-only',
      ANTHROPIC_BASE_URL: inference.url.origin,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const frames: any[] = []
  const errors = new Response(child.stderr).text()
  const reader = (async () => {
    let pending = ''
    for await (const chunk of child.stdout) {
      pending += new TextDecoder().decode(chunk)
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (line.startsWith('{')) frames.push(JSON.parse(line))
      }
    }
  })()
  const send = (frame: unknown) => child.stdin.write(`${JSON.stringify(frame)}\n`)
  async function waitFor(predicate: (frame: any) => boolean): Promise<any> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const found = frames.find(predicate)
      if (found) return found
      if (child.exitCode !== null) {
        throw new Error(`CLI exited ${child.exitCode}: ${(await errors).slice(-2000)}`)
      }
      await Bun.sleep(10)
    }
    throw new Error(`SDK response timed out; frame types: ${frames.map(f => `${f.type}/${f.response?.request_id ?? f.request?.subtype ?? ''}`).join(', ')}`)
  }
  const response = (id: string) => waitFor(frame =>
    frame.type === 'control_response' && frame.response.request_id === id,
  )
  try {
    send({ type: 'control_request', request_id: 'init', request: {
      subtype: 'initialize',
      hooks: { DirectoryAdded: [{ matcher: 'register_repo_root', hookCallbackIds: ['directory-added-test'] }] },
    } })
    expect((await response('init')).response.subtype).toBe('success')

    send({ type: 'control_request', request_id: 'register', request: {
      subtype: 'register_repo_root', directory: repository,
      reload_claude_md: true, reload_skills: true, reload_plugins: true,
    } })
    const hook = await waitFor(frame => frame.type === 'control_request' && frame.request.subtype === 'hook_callback')
    expect(hook.request.callback_id).toBe('directory-added-test')
    expect(hook.request.input).toMatchObject({
      hook_event_name: 'DirectoryAdded', directory: repository, source: 'register_repo_root',
    })
    // A synchronous/blocked input loop cannot service this reply. Keep the
    // hook active until the SDK client explicitly responds, like real hooks.
    send({ type: 'control_response', response: {
      subtype: 'success', request_id: hook.request_id,
      response: { systemMessage: 'directory-added-diagnostic-only' },
    } })
    expect((await response('register')).response).toMatchObject({
      subtype: 'success', response: { directory: repository },
    })
    send({ type: 'control_request', request_id: 'mcp-status', request: { subtype: 'mcp_status' } })
    const mcpStatus = (await response('mcp-status')).response.response.mcpServers
    const repositoryMcp = mcpStatus.find((server: any) => server.name.includes('repo-sdk-mcp'))
    expect(repositoryMcp).toBeDefined()
    // 2.1.221 can expose the newly discovered MCP as pending (lazy connect).
    // Exercise the actual connector with the same explicit SDK command on
    // both CLIs; discovery must not be mislabeled as a completed connection.
    send({ type: 'control_request', request_id: 'mcp-connect', request: {
      subtype: 'mcp_reconnect', serverName: repositoryMcp.name,
    } })
    expect((await response('mcp-connect')).response.subtype).toBe('success')
    send({ type: 'control_request', request_id: 'mcp-connected-status', request: { subtype: 'mcp_status' } })
    const connectedStatus = (await response('mcp-connected-status')).response.response.mcpServers
    expect(connectedStatus.some((server: any) => server.name === repositoryMcp.name && server.status === 'connected')).toBe(true)
    expect(mcpMethods).toContain('initialize')

    // The instruction and skill files were not in cwd during initialize.
    // Verify the running query sees the registered repo, not merely an ACK.
    send({ type: 'user', message: { role: 'user', content: 'Reply with the fixture acknowledgement.' }, parent_tool_use_id: null })
    const result = await waitFor(frame => frame.type === 'result')
    expect(result.subtype).toBe('success')
    expect(result.is_error).toBe(false)
    if (inferenceRequests.length === 0) {
      throw new Error(`No inference request: ${JSON.stringify(frames.filter(frame => frame.type === 'assistant' || frame.type === 'result'))}`)
    }
    const prompt = JSON.stringify(inferenceRequests)
    expect(prompt.includes('REPO_ROOT_MEMORY_SENTINEL')).toBe(true)
    expect(prompt.includes('REPO_ROOT_SKILL_SENTINEL')).toBe(true)
    if (!prompt.includes('REPO_ROOT_PLUGIN_SENTINEL')) {
      const debug = await readFile(join(temporary, 'debug.log'), 'utf8').catch(() => '')
      throw new Error(`Plugin not loaded: ${debug.split('\n').filter(line => /repo-sdk|headlessPluginInstall|marketplace.*fail|marketplace.*skip/i.test(line)).join('\n').slice(-6000)}`)
    }
    expect(prompt.includes('directory-added-diagnostic-only')).toBe(false)

    send({ type: 'control_request', request_id: 'duplicate', request: {
      subtype: 'register_repo_root', directory: repository, reload_plugins: true,
    } })
    expect((await response('duplicate')).response).toMatchObject({ subtype: 'error' })
    expect((await response('duplicate')).response.error).toContain('already a registered')
    send({ type: 'control_request', request_id: 'outside', request: {
      subtype: 'register_repo_root', directory: temporary,
    } })
    expect((await response('outside')).response.subtype).toBe('error')

    child.stdin.end()
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(5000).then(() => { throw new Error('CLI did not drain registration/hooks on EOF') }),
    ])
    await reader
    expect(exitCode).toBe(0)
    expect(frames.filter(frame => frame.request?.subtype === 'hook_callback')).toHaveLength(1)
    expect(frames.some(frame => frame.type === 'assistant')).toBe(true)
    expect(await errors).not.toContain('Error in hook callback')
  } finally {
    child.kill()
    await child.exited
    await reader.catch(() => {})
    await inference.stop(true)
    await mcpServer.stop(true)
    await rm(temporary, { recursive: true, force: true })
  }
}, 55_000)
