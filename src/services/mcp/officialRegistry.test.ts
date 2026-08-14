import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'

const originalEnv = { ...process.env }

async function importFreshModule() {
  mock.restore()
  return import(`./officialRegistry.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  process.env = { ...originalEnv }
})

afterEach(() => {
  process.env = { ...originalEnv }
  mock.restore()
})

describe('prefetchOfficialMcpUrls', () => {
  test('does not fetch registry when using OpenAI mode', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    mock.module('../../utils/model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    const getSpy = mock(() => Promise.resolve({ data: { servers: [] } }))
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).not.toHaveBeenCalled()
  })

  test('does not fetch registry when using Gemini mode', async () => {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    mock.module('../../utils/model/providers.js', () => ({
      getAPIProvider: () => 'gemini',
    }))
    const getSpy = mock(() => Promise.resolve({ data: { servers: [] } }))
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).not.toHaveBeenCalled()
  })

  test('fetches registry in first-party mode', async () => {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GITHUB

    mock.module('../../utils/model/providers.js', () => ({
      getAPIProvider: () => 'firstParty',
    }))
    const getSpy = mock(() =>
      Promise.resolve({
        data: {
          servers: [{ server: { remotes: [{ url: 'https://example.com/mcp' }] } }],
        },
      }),
    )
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls, isOfficialMcpUrl } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(getSpy.mock.calls[0]?.[0]).toBe(
      'https://api.anthropic.com/mcp-registry/v0/servers?version=latest&limit=100&visibility=commercial%2Cgsuite%2Centerprise%2Chealth',
    )
    expect(isOfficialMcpUrl('https://example.com/mcp')).toBe(true)
  })

  test('fetches the owned registry when a custom OAuth control plane is configured', async () => {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GITHUB
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'

    mock.module('../../utils/model/providers.js', () => ({
      getAPIProvider: () => 'firstParty',
    }))
    const getSpy = mock(() =>
      Promise.resolve({
        data: {
          servers: [{ server: { remotes: [{ url: 'https://owned.example/mcp' }] } }],
        },
      }),
    )
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls, isOfficialMcpUrl } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(getSpy.mock.calls[0]?.[0]).toBe(
      'https://ai.darbmind.ru/mcp-registry/v0/servers?version=latest&limit=100&visibility=commercial%2Cgsuite%2Centerprise%2Chealth',
    )
    expect(isOfficialMcpUrl('https://owned.example/mcp')).toBe(true)
  })

  test('loads every registry page using the current Claude Code cursor contract', async () => {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GITHUB

    mock.module('../../utils/model/providers.js', () => ({
      getAPIProvider: () => 'firstParty',
    }))
    const getSpy = mock((url: string) => {
      if (url.includes('cursor=page-2')) {
        return Promise.resolve({
          data: {
            servers: [
              { server: { remotes: [{ url: 'https://second.example/mcp' }] } },
            ],
            metadata: {},
          },
        })
      }
      return Promise.resolve({
        data: {
          servers: [
            { server: { remotes: [{ url: 'https://first.example/mcp' }] } },
          ],
          metadata: { nextCursor: 'page-2' },
        },
      })
    })
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls, isOfficialMcpUrl } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).toHaveBeenCalledTimes(2)
    expect(getSpy.mock.calls[1]?.[0]).toContain(
      'visibility=commercial%2Cgsuite%2Centerprise%2Chealth&cursor=page-2',
    )
    expect(isOfficialMcpUrl('https://first.example/mcp')).toBe(true)
    expect(isOfficialMcpUrl('https://second.example/mcp')).toBe(true)
  })
})
