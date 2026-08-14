const DEFAULT_FIRST_PARTY_BASE_URL = 'https://api.anthropic.com'
const STAGING_FIRST_PARTY_BASE_URL = 'https://api-staging.anthropic.com'

function normalizedHTTPOrigin(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`)
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error(
      `${name} must be an HTTP(S) origin without credentials, path, query, or fragment`,
    )
  }
  return url.origin
}

export function hasHostManagedFirstPartyEventLogging(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const managedByHost =
    environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === '1' ||
    environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === 'true'
  return Boolean(
    environment.CLAUDE_CODE_1P_EVENT_LOGGING_BASE_URL?.trim() ||
      (managedByHost && environment.CLAUDE_CODE_GB_BASE_URL?.trim()),
  )
}

/**
 * A host-managed endpoint is authoritative and cannot be overridden by a
 * stale dynamic config. This prevents a Darbmind build from falling back to
 * api.anthropic.com before its first successful GrowthBook refresh.
 */
export function resolveFirstPartyEventLoggingBaseUrl(
  dynamicBaseUrl?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const managedByHost =
    environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === '1' ||
    environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === 'true'
  const hostManagedBaseUrl =
    environment.CLAUDE_CODE_1P_EVENT_LOGGING_BASE_URL?.trim() ||
    (managedByHost ? environment.CLAUDE_CODE_GB_BASE_URL?.trim() : undefined)

  if (hostManagedBaseUrl) {
    return normalizedHTTPOrigin(
      hostManagedBaseUrl,
      'CLAUDE_CODE_1P_EVENT_LOGGING_BASE_URL',
    )
  }
  if (dynamicBaseUrl?.trim()) {
    return normalizedHTTPOrigin(dynamicBaseUrl, 'event logging baseUrl')
  }
  return environment.ANTHROPIC_BASE_URL === STAGING_FIRST_PARTY_BASE_URL
    ? STAGING_FIRST_PARTY_BASE_URL
    : DEFAULT_FIRST_PARTY_BASE_URL
}
