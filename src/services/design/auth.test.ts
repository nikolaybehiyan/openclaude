import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  beginDesignOAuth,
  completeDesignOAuthWithDependencies,
  getHostedDesignSessionToken,
} from './auth.js'
import type { DesignOAuthSlot } from './types.js'

let saved: DesignOAuthSlot | null = null

const originalFetch = globalThis.fetch
const originalOauthBase = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
const originalClientId = process.env.CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID
const originalRemote = process.env.CLAUDE_CODE_REMOTE
const originalRemoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
const originalSessionToken = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN

beforeEach(() => {
  saved = null
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
  process.env.CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID = 'design-client-test'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalOauthBase === undefined) {
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  } else {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = originalOauthBase
  }
  if (originalClientId === undefined) {
    delete process.env.CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID
  } else {
    process.env.CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID = originalClientId
  }
  for (const [name, value] of [
    ['CLAUDE_CODE_REMOTE', originalRemote],
    ['CLAUDE_CODE_REMOTE_SESSION_ID', originalRemoteSessionId],
    ['CLAUDE_CODE_SESSION_ACCESS_TOKEN', originalSessionToken],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('separate Claude Design OAuth', () => {
  test('uses the lease-bound hosted session capability in Claude Code Web', () => {
    process.env.CLAUDE_CODE_REMOTE = '1'
    process.env.CLAUDE_CODE_REMOTE_SESSION_ID = 'cse-web'
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'worker-session-capability'
    expect(getHostedDesignSessionToken()).toBe('worker-session-capability')

    delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    expect(getHostedDesignSessionToken()).toBe(null)
  })

  test('requests only the two Design scopes with PKCE and manual redirect', async () => {
    const pending = await beginDesignOAuth()
    const url = new URL(pending.authorizationURL)
    expect(url.origin).toBe('https://ai.darbmind.ru')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('design-client-test')
    expect(url.searchParams.get('scope')).toBe(
      'user:design:read user:design:write',
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://ai.darbmind.ru/oauth/code/callback',
    )
  })

  test('exchanges and stores a bounded, scope-checked Design credential', async () => {
    const pending = await beginDesignOAuth()
    let request: { url: string; init?: RequestInit } | undefined
    const fetcher = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      request = { url: String(url), init }
      return new Response(
        JSON.stringify({
          access_token: 'design-access',
          refresh_token: 'design-refresh',
          expires_in: 3600,
          scope: 'user:design:read user:design:write',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    await completeDesignOAuthWithDependencies(
      pending,
      `auth-code#${pending.state}`,
      undefined,
      {
        fetcher,
        save: (slot) => {
          saved = slot
          return { success: true }
        },
      },
    )

    expect(request?.url).toBe('https://ai.darbmind.ru/v1/oauth/token')
    expect(request?.init?.redirect).toBe('error')
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'auth-code',
      client_id: 'design-client-test',
      code_verifier: pending.codeVerifier,
      state: pending.state,
    })
    expect(saved).toMatchObject({
      accessToken: 'design-access',
      refreshToken: 'design-refresh',
      clientId: 'design-client-test',
      scopes: ['user:design:read', 'user:design:write'],
    })
  })

  test('fails closed when either Design scope is absent', async () => {
    const pending = await beginDesignOAuth()
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'bad-access',
          refresh_token: 'bad-refresh',
          expires_in: 3600,
          scope: 'user:design:read',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch

    await expect(
      completeDesignOAuthWithDependencies(
        pending,
        `auth-code#${pending.state}`,
        undefined,
        {
          fetcher,
          save: (slot) => {
            saved = slot
            return { success: true }
          },
        },
      ),
    ).rejects.toThrow('missing: user:design:write')
    expect(saved).toBe(null)
  })
})
