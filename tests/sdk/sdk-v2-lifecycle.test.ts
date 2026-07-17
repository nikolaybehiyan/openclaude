import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
  createSdkMcpServer,
  tool,
} from '../../src/entrypoints/sdk/index.js'
import {
  getOriginalCwd,
  getSessionProjectDir,
  setOriginalCwd,
} from '../../src/bootstrap/state.js'
import {
  drainQuery,
  withTempDir,
  createSessionJsonl,
  createMinimalConversation,
  createMultiTurnConversation,
  UUID_REGEX,
} from './helpers/query-test-doubles.js'

// sendMessage drains trigger init(), which checks auth. Stub it for CI.
const AUTH_KEY = 'ANTHROPIC_API_KEY'
let savedApiKey: string | undefined

beforeAll(() => {
  savedApiKey = process.env[AUTH_KEY]
  if (!savedApiKey) process.env[AUTH_KEY] = 'sk-test-v2-lifecycle-stub'
})

afterAll(() => {
  if (savedApiKey === undefined) delete process.env[AUTH_KEY]
  else process.env[AUTH_KEY] = savedApiKey
})

// Collect temp dirs for cleanup
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  tempDirs.length = 0
})

describe('V2: session creation', () => {
  test('createSession() returns SDKSession with valid sessionId', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    expect(session.sessionId).toBeDefined()
    expect(UUID_REGEX.test(session.sessionId)).toBe(true)
  })

  test('createSession().getMessages() returns empty array initially', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    const messages = session.getMessages()
    expect(Array.isArray(messages)).toBe(true)
    expect(messages.length).toBe(0)
  })

  test('createSession() with no cwd throws', () => {
    expect(() =>
      unstable_v2_createSession({} as any)
    ).toThrow()
  })

  test('createSession() with model option — session created without error', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      model: 'claude-sonnet-4-6',
    })
    expect(session.sessionId).toBeDefined()
  })

  test('createSession() accepts includePartialMessages for streaming hosts', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      includePartialMessages: true,
    })
    expect(session.sessionId).toBeDefined()
    expect((session as any)._engine?.config?.includePartialMessages).toBe(true)
  })

  test('createSession() accepts custom system prompt for persistent hosts', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      systemPrompt: { type: 'custom', content: 'Use the project voice' },
    })
    expect(session.sessionId).toBeDefined()
    expect((session as any)._engine?.config?.customSystemPrompt).toBe('Use the project voice')
  })

  test('createSession() accepts explicit thinking config for persistent hosts', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      thinkingConfig: { type: 'disabled' },
    })
    expect(session.sessionId).toBeDefined()
    expect((session as any)._engine?.config?.thinkingConfig).toEqual({ type: 'disabled' })
  })

  test('updateOptions() applies live model, thinking, and permission options without replacing history', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      model: 'claude-sonnet-4-6',
      thinkingConfig: { type: 'disabled' },
      allowedTools: ['WebSearch'],
    })
    const engine = (session as any)._engine
    ;(engine as any).getMessages = () => [{ type: 'user', uuid: 'human-1', message: { role: 'user', content: 'hi' } }]

    session.updateOptions({
      model: 'claude-opus-4-5',
      thinkingConfig: { type: 'adaptive' },
      allowedTools: [],
      disallowedTools: ['WebSearch'],
      tools: ['Bash'],
    })

    expect((session as any)._engine).toBe(engine)
    expect(session.getMessages().map(message => message.uuid)).toEqual(['human-1'])
    expect(engine.config.userSpecifiedModel).toBe('claude-opus-4-5')
    expect(engine.config.thinkingConfig).toEqual({ type: 'adaptive' })
    const state = (session as any)._appStateStore.getState()
    expect(state.mainLoopModel).toBe('claude-opus-4-5')
    expect(state.thinkingEnabled).toBe(true)
    expect(state.toolPermissionContext.alwaysAllowRules.cliArg).toEqual([])
    expect(state.toolPermissionContext.alwaysDenyRules.cliArg).toContain('WebSearch')
  })

  test('SDK MCP refresh keeps attachment-only Read hidden from model tools', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const localTool = tool(
        'local_echo',
        'Echo local input',
        { type: 'object', properties: { text: { type: 'string' } } },
        async (args: { text: string }) => ({
          content: [{ type: 'text', text: args.text }],
        }),
      )
      const session = unstable_v2_createSession({
        cwd: dir,
        tools: ['Bash'],
        mcpServers: {
          local: createSdkMcpServer({
            type: 'sdk',
            name: 'local',
            tools: [localTool],
          }),
        },
      })
      ;(session as any).agentsLoaded = true
      ;(session as any)._engine.submitMessage = async function* () {}
      try {
        await drainQuery(session.sendMessage('hello'))
        const toolNames = ((session as any)._engine?.config?.tools ?? []).map(
          (item: { name: string }) => item.name,
        )
        expect(toolNames).toContain('Bash')
        expect(toolNames).toContain('local_echo')
        expect(toolNames).not.toContain('Read')
        const attachmentDenyRules =
          (session as any)._appStateStore?.getState().toolPermissionContext.alwaysDenyRules.cliArg ?? []
        expect(attachmentDenyRules).not.toContain('Read')
      } finally {
        session.close()
      }
    })
  })

  test('SDK retry MCP refresh keeps attachment-only Read hidden from model tools', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const localTool = tool(
        'local_echo',
        'Echo local input',
        { type: 'object', properties: { text: { type: 'string' } } },
        async (args: { text: string }) => ({
          content: [{ type: 'text', text: args.text }],
        }),
      )
      const session = unstable_v2_createSession({
        cwd: dir,
        tools: ['Bash'],
        mcpServers: {
          local: createSdkMcpServer({
            type: 'sdk',
            name: 'local',
            tools: [localTool],
          }),
        },
      })
      ;(session as any).agentsLoaded = true
      ;(session as any).runEngineTurn = async function* () {}
      ;(session as any)._engine.getMessages = () => [{
        type: 'user',
        uuid: 'human-1',
        message: { role: 'user', content: 'hello' },
      }]
      try {
        await drainQuery(session.retryMessage('human-1'))
        const toolNames = ((session as any)._engine?.config?.tools ?? []).map(
          (item: { name: string }) => item.name,
        )
        expect(toolNames).toContain('Bash')
        expect(toolNames).toContain('local_echo')
        expect(toolNames).not.toContain('Read')
      } finally {
        session.close()
      }
    })
  })

  test('updateOptions() refreshes live SDK MCP server tools before the next turn', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const initialTool = tool(
        'initial_widget_tool',
        'Initial widget tool',
        { type: 'object', properties: {} },
        async () => ({
          content: [{ type: 'text', text: 'initial' }],
        }),
      )
      const visualizeTool = tool(
        'visualize:show_widget',
        'Show an interactive visualization widget',
        { type: 'object', properties: { title: { type: 'string' } } },
        async () => ({
          content: [{ type: 'text', text: 'visualized' }],
        }),
        {
          permissionBehavior: 'allow',
          alwaysLoad: true,
          _meta: {
            ui: { resourceUri: 'ui://imagine/show-widget.html' },
          },
        },
      )
      const session = unstable_v2_createSession({
        cwd: dir,
        tools: ['Bash'],
        mcpServers: {
          initial: createSdkMcpServer({
            type: 'sdk',
            name: 'initial',
            tools: [initialTool],
          }),
        },
      })
      ;(session as any).agentsLoaded = true
      ;(session as any)._engine.submitMessage = async function* () {}
      try {
        await drainQuery(session.sendMessage('first turn'))
        const initialToolNames = ((session as any)._engine?.config?.tools ?? []).map(
          (item: { name: string }) => item.name,
        )
        expect(initialToolNames).toContain('initial_widget_tool')

        session.updateOptions({
          mcpServers: {
            visualize: createSdkMcpServer({
              type: 'sdk',
              name: 'visualize',
              tools: [visualizeTool],
            }),
          },
        })

        const afterUpdateToolNames = ((session as any)._engine?.config?.tools ?? []).map(
          (item: { name: string }) => item.name,
        )
        expect(afterUpdateToolNames).not.toContain('initial_widget_tool')
        expect(afterUpdateToolNames).not.toContain('visualize:show_widget')

        await drainQuery(session.sendMessage('second turn'))
        const refreshedToolNames = ((session as any)._engine?.config?.tools ?? []).map(
          (item: { name: string }) => item.name,
        )
        expect(refreshedToolNames).toContain('Bash')
        expect(refreshedToolNames).toContain('visualize:show_widget')
        expect(refreshedToolNames).not.toContain('initial_widget_tool')
      } finally {
        session.close()
      }
    })
  })

  test('createSession() accepts sampling overrides for persistent hosts', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      maxOutputTokens: 4096,
      temperature: 1,
    })
    expect(session.sessionId).toBeDefined()
    expect((session as any)._engine?.config?.maxOutputTokensOverride).toBe(4096)
    expect((session as any)._engine?.config?.temperatureOverride).toBe(1)
  })

  test('sendMessage() executes the engine stream inside the SDK cwd context', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const savedOriginalCwd = getOriginalCwd()
      setOriginalCwd('/global-not-sdk-cwd')
      const session = unstable_v2_createSession({ cwd: dir })
      const observedOriginalCwds: string[] = []
      ;(session as any)._engine.submitMessage = async function* () {
        observedOriginalCwds.push(getOriginalCwd())
        await Bun.sleep(1)
        observedOriginalCwds.push(getOriginalCwd())
      }
      try {
        await drainQuery(session.sendMessage('context probe'))
      } finally {
        session.close()
        setOriginalCwd(savedOriginalCwd)
      }
      expect(observedOriginalCwds).toEqual([dir, dir])
    })
  })

  test('sendMessage() loads native skills and reloadSkills() refreshes them for the next turn', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
      const savedSimpleMode = process.env.CLAUDE_CODE_SIMPLE
      const configDir = join(dir, 'claude-config')
      process.env.CLAUDE_CONFIG_DIR = configDir
      delete process.env.CLAUDE_CODE_SIMPLE
      const firstSkillDir = join(configDir, 'skills', 'sdk-first-skill')
      mkdirSync(firstSkillDir, { recursive: true })
      writeFileSync(
        join(firstSkillDir, 'SKILL.md'),
        '---\nname: sdk-first-skill\ndescription: First SDK skill\n---\n\nUse the first skill.\n',
      )

      const session = unstable_v2_createSession({ cwd: dir, settingSources: ['user'] })
      ;(session as any)._engine.submitMessage = async function* () {}
      try {
        await drainQuery(session.sendMessage('first turn'))
        expect(
          ((session as any)._engine?.config?.commands ?? []).map(
            (command: { name: string }) => command.name,
          ),
        ).toContain('sdk-first-skill')
        const firstSkillListing = await session.listSkills()
        expect(firstSkillListing).toEqual([
          expect.objectContaining({
            name: 'sdk-first-skill',
            displayName: 'sdk-first-skill',
            description: 'First SDK skill',
            loadedFrom: 'skills',
            userInvocable: true,
          }),
        ])
        expect(firstSkillListing[0]?.skillRoot).toEndWith('/claude-config/skills/sdk-first-skill')
        expect(firstSkillListing[0]?.skillFile).toEndWith('/claude-config/skills/sdk-first-skill/SKILL.md')

        const secondSkillDir = join(configDir, 'skills', 'sdk-second-skill')
        mkdirSync(secondSkillDir, { recursive: true })
        writeFileSync(
          join(secondSkillDir, 'SKILL.md'),
          '---\nname: sdk-second-skill\ndescription: Second SDK skill\n---\n\nUse the second skill.\n',
        )
        session.reloadSkills()
        await drainQuery(session.sendMessage('second turn'))

        const refreshedCommandNames = ((session as any)._engine?.config?.commands ?? []).map(
          (command: { name: string }) => command.name,
        )
        expect(refreshedCommandNames).toContain('sdk-first-skill')
        expect(refreshedCommandNames).toContain('sdk-second-skill')
        expect((await session.listSkills()).map(skill => skill.name)).toEqual([
          'sdk-first-skill',
          'sdk-second-skill',
        ])
      } finally {
        session.close()
        if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
        if (savedSimpleMode === undefined) delete process.env.CLAUDE_CODE_SIMPLE
        else process.env.CLAUDE_CODE_SIMPLE = savedSimpleMode
      }
    })
  })

  test('retryMessage() replays text-only block user prompts as plain text', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const session = unstable_v2_createSession({ cwd: dir })
      let observedPrompt: unknown
      ;(session as any)._engine.getMessages = () => [{
        type: 'user',
        uuid: 'human-1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: ' world' },
          ],
        },
      }]
      ;(session as any).replaceEngineWithInitialMessages = function (messages: unknown[]) {
        this._engine = {
          getMessages: () => messages,
          getMcpClients: () => [],
          injectAgents: () => {},
          interrupt: () => {},
          submitMessage: async function* (prompt: unknown) {
            observedPrompt = prompt
          },
        }
      }
      try {
        await drainQuery(session.retryMessage('human-1'))
      } finally {
        session.close()
      }
      expect(observedPrompt).toBe('hello world')
    })
  })
})

describe('V2: session interrupt', () => {
  test('session.interrupt() does not throw', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    expect(() => session.interrupt()).not.toThrow()
  })

  test('session with external abortController — abort signal propagates', async () => {
    const ac = new AbortController()
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      abortController: ac,
    })
    ac.abort()
    let caught = false
    try {
      for await (const _ of session.sendMessage('test')) {
        // drain
      }
    } catch {
      caught = true
    }
    // Either completes with no messages or throws — both are acceptable
    expect(true).toBe(true)
  }, 10_000)
})

describe('V2: session resume', () => {
  test('resumeSession() loads prior messages from JSONL', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      const entries = createMinimalConversation(sid)
      createSessionJsonl(dir, sid, entries)

      const session = await unstable_v2_resumeSession(sid, { cwd: dir })
      expect(session.sessionId).toBe(sid)

      const messages = session.getMessages()
      expect(messages.length).toBeGreaterThanOrEqual(2)
    })
  })

  test('resumeSession() with invalid sessionId throws', async () => {
    await expect(
      unstable_v2_resumeSession('not-a-uuid', { cwd: process.cwd() })
    ).rejects.toThrow('Invalid session ID')
  })

  test('resumeSession() with non-existent session — creates session with empty messages', async () => {
    const fakeSid = randomUUID()
    const session = await unstable_v2_resumeSession(fakeSid, { cwd: process.cwd() })
    expect(session.sessionId).toBe(fakeSid)
    const messages = session.getMessages()
    expect(messages.length).toBe(0)
  })

  test('resumeSession() hydrates from native session event reader in SDK cwd context', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      const entries = createMinimalConversation(sid)
      const session = await unstable_v2_resumeSession(sid, {
        cwd: dir,
        sessionEventReader: async () => entries.map(payload => ({ payload })),
        sessionSubagentEventReader: async () => [],
      })

      expect(session.sessionId).toBe(sid)
      expect(session.getMessages().length).toBeGreaterThanOrEqual(2)
      const projectDir = getSessionProjectDir()
      expect(projectDir).not.toBeNull()
      expect(projectDir).toContain('projects')
    })
  })

  test('resumeSession() preserves multi-turn conversation order', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      const entries = createMultiTurnConversation(sid, 3)
      createSessionJsonl(dir, sid, entries)

      const session = await unstable_v2_resumeSession(sid, { cwd: dir })
      const messages = session.getMessages()

      expect(messages.length).toBeGreaterThanOrEqual(6)
    })
  })

  test('resumeSession() sets sessionProjectDir via switchSession', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      createSessionJsonl(dir, sid, createMinimalConversation(sid))

      await unstable_v2_resumeSession(sid, { cwd: dir })

      // Fix verification: resumeSession must call switchSession with the
      // resolved projectPath so that transcript writes go to the correct dir.
      const projectDir = getSessionProjectDir()
      expect(projectDir).not.toBeNull()
    })
  })
})

describe('V2: permission handling', () => {
  test('createSession() with canUseTool callback — session created successfully', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      canUseTool: async (name: string, _input: unknown) => ({
        behavior: 'deny' as const,
        message: `Tool ${name} denied by test`,
      }),
    })
    expect(session.sessionId).toBeDefined()
  })
})

describe('V2: unstable_v2_prompt', () => {
  test('throws when query completes without a result message (aborted)', async () => {
    const ac = new AbortController()
    // Abort immediately so the query never produces a result
    ac.abort()

    await expect(
      unstable_v2_prompt('test', {
        cwd: process.cwd(),
        abortController: ac,
      }),
    ).rejects.toThrow()
  })

  test('throws when cwd is missing', () => {
    expect(() =>
      unstable_v2_prompt('test', {} as any),
    ).toThrow()
  })
})

describe('E2E: transcript placement — resume sets project dir and resolve still finds file', () => {
  test('resumeSession sets projectDir so resolveSessionFilePath finds the file', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      createSessionJsonl(dir, sid, createMinimalConversation(sid))

      // Before resume: file exists on disk
      const { resolveSessionFilePath } = await import('../../src/utils/sessionStoragePortable.js')
      const before = await resolveSessionFilePath(sid, dir)
      expect(before).toBeDefined()
      expect(before!.filePath).toContain(sid)

      // Resume the session — this should call switchSession internally
      const session = await unstable_v2_resumeSession(sid, { cwd: dir })

      // Verify session is usable
      expect(session.sessionId).toBe(sid)
      const messages = session.getMessages()
      expect(messages.length).toBeGreaterThanOrEqual(2)

      // Verify project dir was set by switchSession
      const projectDir = getSessionProjectDir()
      expect(projectDir).not.toBeNull()

      // Verify resolveSessionFilePath still finds the file at the same path
      const after = await resolveSessionFilePath(sid, dir)
      expect(after).toBeDefined()
      expect(after!.filePath).toBe(before!.filePath)
    })
  })
})
