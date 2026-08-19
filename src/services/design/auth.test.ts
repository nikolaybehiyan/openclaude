import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let storage: Record<string, unknown> = {}

mock.module('../../utils/secureStorage/index.js', () => ({
  getSecureStorage: () => ({
    read: () => storage,
    update: (next: Record<string, unknown>) => {
      storage = next
      return { success: true }
    },
  }),
}))

const { beginDesignOAuth, completeDesignOAuth, getStoredDesignOAuth } =
  await import('./auth.js')

const originalFetch = globalThis.fetch
const originalOauthBase = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
const originalClientId = process.env.CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID

beforeEach(() => {
  storage = {}
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
})

describe('separate Claude Design OAuth', () => {
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
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
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

    await completeDesignOAuth(pending, `auth-code#${pending.state}`)

    expect(request?.url).toBe('https://ai.darbmind.ru/v1/oauth/token')
    expect(request?.init?.redirect).toBe('error')
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'auth-code',
      client_id: 'design-client-test',
      code_verifier: pending.codeVerifier,
      state: pending.state,
    })
    expect(getStoredDesignOAuth()).toMatchObject({
      accessToken: 'design-access',
      refreshToken: 'design-refresh',
      clientId: 'design-client-test',
      scopes: ['user:design:read', 'user:design:write'],
    })
  })

  test('fails closed when either Design scope is absent', async () => {
    const pending = await beginDesignOAuth()
    globalThis.fetch = (async () =>
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
      completeDesignOAuth(pending, `auth-code#${pending.state}`),
    ).rejects.toThrow('missing: user:design:write')
    expect(getStoredDesignOAuth()).toBe(null)
  })
})
