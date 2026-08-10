const DEFAULT_GROWTHBOOK_API_HOST = 'https://api.anthropic.com/'

export type GrowthBookTransport = {
  apiHost: string
  requiresAnthropicAuth: boolean
}

function normalizedHTTPURL(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password || url.search || url.hash) return null
    return url.href
  } catch {
    return null
  }
}

/**
 * Resolve the feature-control transport independently from the model provider.
 *
 * Claude Code's default endpoint is Anthropic and uses Claude auth headers.
 * Host-managed distributions may provide a separate GrowthBook remote-eval
 * endpoint with CLAUDE_CODE_GB_BASE_URL. Such endpoints authenticate with the
 * GrowthBook SDK client key and must never receive the model-provider bearer
 * credential from ANTHROPIC_BASE_URL/apiKeyHelper.
 */
export function resolveGrowthBookTransport(
  environment: NodeJS.ProcessEnv = process.env,
): GrowthBookTransport {
  const configured = environment.CLAUDE_CODE_GB_BASE_URL?.trim()
  const apiHost = configured
    ? normalizedHTTPURL(configured)
    : DEFAULT_GROWTHBOOK_API_HOST

  if (!apiHost) {
    throw new Error('CLAUDE_CODE_GB_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment')
  }

  return {
    apiHost,
    requiresAnthropicAuth:
      new URL(apiHost).origin === new URL(DEFAULT_GROWTHBOOK_API_HOST).origin,
  }
}

