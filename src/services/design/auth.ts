import { getOauthConfig, DESIGN_OAUTH_SCOPES } from '../../constants/oauth.js'
import {
  getClaudeAIOAuthTokensAsync,
  handleOAuth401Error,
} from '../../utils/auth.js'
import { getSecureStorage, type SecureStorageData } from '../../utils/secureStorage/index.js'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../oauth/crypto.js'
import { DESIGN_LOGIN_TIMEOUT_MS } from './constants.js'
import { designGateFailure } from './gate.js'
import type { DesignAuthResult, DesignOAuthSlot } from './types.js'

type StorageWithDesign = SecureStorageData & {
  designOauth?: DesignOAuthSlot
  claudeAiOauth?: {
    accessToken: string
    refreshToken: string | null
    expiresAt: number | null
    scopes: string[]
  }
}

type DesignOAuthTokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
}

const REFRESH_SKEW_MS = 300_000

function designStorage() {
  return getSecureStorage()
}

export function getStoredDesignOAuth(): DesignOAuthSlot | null {
  try {
    const data = designStorage().read() as StorageWithDesign | null
    return data?.designOauth ?? null
  } catch {
    return null
  }
}

export function saveStoredDesignOAuth(slot: DesignOAuthSlot): {
  success: boolean
  warning?: string
} {
  const storage = designStorage()
  const data = (storage.read() ?? {}) as StorageWithDesign
  return storage.update({ ...data, designOauth: slot } as SecureStorageData)
}

export function clearStoredDesignOAuth(
  onlyIf?: (slot: DesignOAuthSlot) => boolean,
): boolean {
  const storage = designStorage()
  const data = (storage.read() ?? {}) as StorageWithDesign
  if (!data.designOauth || (onlyIf && !onlyIf(data.designOauth))) return true
  const next = { ...data }
  delete next.designOauth
  return storage.update(next as SecureStorageData).success
}

export function getDesignOAuthClientID(): string {
  return (
    process.env.CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID ??
    getOauthConfig().DESIGN_CLIENT_ID
  )
}

export function isDesignOAuthClientConfigured(): boolean {
  return !getDesignOAuthClientID().startsWith('00000000-')
}

async function postToken(body: Record<string, unknown>, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch(getOauthConfig().TOKEN_URL, {
    method: 'POST',
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as DesignOAuthTokenResponse & {
    error?: string
  }
  if (!response.ok) {
    throw new Error(`Design OAuth token exchange failed (HTTP ${response.status})`)
  }
  return payload
}

function slotFromTokenResponse(
  response: DesignOAuthTokenResponse,
  clientId: string,
  previousRefreshToken?: string,
): DesignOAuthSlot {
  const scopes = response.scope.split(' ').filter(Boolean)
  const missing = DESIGN_OAUTH_SCOPES.filter(scope => !scopes.includes(scope))
  if (missing.length > 0) {
    throw new Error(
      `The authorization server did not grant the design scopes (missing: ${missing.join(', ')}) — the Claude Design app registration may be incomplete or out of date.`,
    )
  }
  const refreshToken = response.refresh_token ?? previousRefreshToken
  if (!refreshToken || !response.expires_in) {
    throw new Error(
      'The token response was missing a refresh token or expiry — cannot store a usable design credential.',
    )
  }
  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Date.now() + response.expires_in * 1000,
    scopes: scopes.filter(scope =>
      DESIGN_OAUTH_SCOPES.includes(scope as (typeof DESIGN_OAUTH_SCOPES)[number]),
    ),
    clientId,
  }
}

async function refreshStoredDesignOAuth(
  slot: DesignOAuthSlot,
  signal?: AbortSignal,
): Promise<DesignAuthResult> {
  try {
    const response = await postToken(
      {
        grant_type: 'refresh_token',
        refresh_token: slot.refreshToken,
        client_id: slot.clientId,
        scope: slot.scopes.join(' '),
      },
      signal,
    )
    const refreshed = slotFromTokenResponse(
      response,
      slot.clientId,
      slot.refreshToken,
    )
    const latest = getStoredDesignOAuth()
    if (latest?.refreshToken !== slot.refreshToken) {
      return latest && latest.expiresAt > Date.now()
        ? { ok: true, accessToken: latest.accessToken }
        : { ok: false, reason: 'needs_design_login' }
    }
    const saved = saveStoredDesignOAuth(refreshed)
    if (!saved.success) {
      return { ok: true, accessToken: refreshed.accessToken }
    }
    return { ok: true, accessToken: refreshed.accessToken }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'refresh failed'
    if (/401|invalid_grant|expired/i.test(detail)) {
      clearStoredDesignOAuth(
        current => current.refreshToken === slot.refreshToken,
      )
      return {
        ok: false,
        reason: 'needs_design_login',
        detail: 'design authorization expired',
      }
    }
    return { ok: false, reason: 'design_refresh_failed', detail }
  }
}

export async function resolveDesignAccessToken(
  signal?: AbortSignal,
): Promise<DesignAuthResult> {
  const gate = designGateFailure()
  if (gate) return { ok: false, reason: gate }
  const primary = await getClaudeAIOAuthTokensAsync()
  if (
    primary?.accessToken &&
    primary.refreshToken &&
    primary.scopes.includes('user:design:read')
  ) {
    return { ok: true, accessToken: primary.accessToken }
  }

  const design = getStoredDesignOAuth()
  if (design?.accessToken) {
    if (Date.now() + REFRESH_SKEW_MS < design.expiresAt) {
      return { ok: true, accessToken: design.accessToken }
    }
    const refreshed = await refreshStoredDesignOAuth(design, signal)
    if (refreshed.ok) return refreshed
    if (refreshed.reason === 'design_refresh_failed') return refreshed
  }

  // 2.1.221 deliberately lets the server return insufficient_scope for an
  // older primary token so the user gets the canonical re-authorization path.
  if (primary?.accessToken) {
    return { ok: true, accessToken: primary.accessToken }
  }
  return { ok: false, reason: 'needs_design_login' }
}

export async function refreshDesignAccessTokenAfter401(
  failedToken: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const primary = await getClaudeAIOAuthTokensAsync()
  if (
    primary?.accessToken === failedToken &&
    primary.refreshToken &&
    (await handleOAuth401Error(failedToken).catch(() => false))
  ) {
    const refreshed = await getClaudeAIOAuthTokensAsync()
    return refreshed?.accessToken && refreshed.accessToken !== failedToken
      ? refreshed.accessToken
      : null
  }
  const design = getStoredDesignOAuth()
  if (design?.accessToken === failedToken) {
    const refreshed = await refreshStoredDesignOAuth(
      { ...design, expiresAt: 0 },
      signal,
    )
    return refreshed.ok && refreshed.accessToken !== failedToken
      ? refreshed.accessToken
      : null
  }
  const current = await resolveDesignAccessToken(signal)
  return current.ok && current.accessToken !== failedToken
    ? current.accessToken
    : null
}

export type PendingDesignOAuth = {
  authorizationURL: string
  state: string
  codeVerifier: string
  clientId: string
}

export async function beginDesignOAuth(): Promise<PendingDesignOAuth> {
  const clientId = getDesignOAuthClientID()
  if (!isDesignOAuthClientConfigured()) {
    throw new Error(
      'The Claude Design OAuth client is not configured in this build. Set CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID to the registered client id, or update to a build with the registered client.',
    )
  }
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = generateState()
  const url = new URL(getOauthConfig().CLAUDE_AI_AUTHORIZE_URL)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', getOauthConfig().MANUAL_REDIRECT_URL)
  url.searchParams.set('scope', DESIGN_OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  return { authorizationURL: url.toString(), state, codeVerifier, clientId }
}

export async function completeDesignOAuth(
  pending: PendingDesignOAuth,
  pastedCode: string,
  signal?: AbortSignal,
): Promise<void> {
  const [authorizationCode, state] = pastedCode.trim().split('#')
  if (!authorizationCode || state !== pending.state) {
    throw new Error('Invalid code. Please make sure the full code was copied')
  }
  const response = await postToken(
    {
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: getOauthConfig().MANUAL_REDIRECT_URL,
      client_id: pending.clientId,
      code_verifier: pending.codeVerifier,
      state,
    },
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(DESIGN_LOGIN_TIMEOUT_MS)])
      : AbortSignal.timeout(DESIGN_LOGIN_TIMEOUT_MS),
  )
  const slot = slotFromTokenResponse(response, pending.clientId)
  if (!saveStoredDesignOAuth(slot).success) {
    throw new Error(
      'Could not save the design credential to secure storage. Retry, or run /design-login.',
    )
  }
}

export function describeDesignAuthFailure(
  result: Exclude<DesignAuthResult, { ok: true }>,
  nonInteractive: boolean,
): string {
  const detail = result.detail ? ` (${result.detail})` : ''
  switch (result.reason) {
    case 'needs_design_login':
      return nonInteractive
        ? 'DesignSync needs design-system authorization, but /design-login requires an interactive terminal and is not available in this environment. If this is claude.ai/code, ask the user to use Claude Design\'s "Send to Claude Code Web" (which seeds the project into the workspace) or to provide the project files directly.'
        : 'DesignSync needs design-system authorization. Run /design-login to authorize it with your claude.ai account — this works even when this session authenticates with an API key or a provider token.'
    case 'design_refresh_failed':
      return nonInteractive
        ? `Could not refresh the design access token (transient error). Retry shortly; if the error persists, the stored credential needs re-authorization from an interactive Claude Code terminal (not available here).${detail}`
        : `Could not refresh the design access token (transient error). Retry shortly, or run /design-login to re-authorize.${detail}`
    case 'wrong_provider':
      return 'DesignSync is only available with claude.ai authentication. It is not supported through Bedrock, Vertex, or other third-party providers.'
    case 'essential_traffic_only':
      return 'DesignSync is unavailable while nonessential network traffic is restricted (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set). Unset it to use /design-sync.'
    case 'disabled':
      return 'Claude Design access is disabled by managed policy.'
  }
}
