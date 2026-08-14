import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getAPIProvider } from '../../utils/model/providers.js'

type RegistryServer = {
  server: {
    remotes?: Array<{ url: string }>
  }
}

type RegistryResponse = {
  servers: RegistryServer[]
  metadata?: {
    nextCursor?: string
  }
}

const officialRegistryVisibility =
  'commercial,gsuite,enterprise,health'

function officialRegistryURL(): string {
  return `${getOauthConfig().BASE_API_URL}/mcp-registry/v0/servers`
}

// URLs stripped of query string and trailing slash — matches the normalization
// done by getLoggingSafeMcpBaseUrl so direct Set.has() lookup works.
let officialUrls: Set<string> | undefined = undefined

function normalizeUrl(url: string): string | undefined {
  try {
    const u = new URL(url)
    u.search = ''
    return u.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

/**
 * Fire-and-forget fetch of the official MCP registry.
 * Populates officialUrls for isOfficialMcpUrl lookups.
 */
export async function prefetchOfficialMcpUrls(): Promise<void> {
  if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    return
  }

  // The official first-party MCP registry is only relevant for first-party mode.
  if (getAPIProvider() !== 'firstParty') {
    return
  }

  try {
    const urls = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    do {
      const query = new URLSearchParams({
        version: 'latest',
        limit: '100',
        visibility: officialRegistryVisibility,
      })
      if (cursor) {
        query.set('cursor', cursor)
      }
      const response = await axios.get<RegistryResponse>(
        `${officialRegistryURL()}?${query.toString()}`,
        { timeout: 5000 },
      )

      for (const entry of response.data.servers) {
        for (const remote of entry.server.remotes ?? []) {
          const normalized = normalizeUrl(remote.url)
          if (normalized) {
            urls.add(normalized)
          }
        }
      }

      cursor = response.data.metadata?.nextCursor?.trim() || undefined
      if (cursor && seenCursors.has(cursor)) {
        throw new Error('MCP registry returned a repeated pagination cursor')
      }
      if (cursor) {
        seenCursors.add(cursor)
      }
    } while (cursor)

    officialUrls = urls
    logForDebugging(`[mcp-registry] Loaded ${urls.size} official MCP URLs`)
  } catch (error) {
    logForDebugging(`Failed to fetch MCP registry: ${errorMessage(error)}`, {
      level: 'error',
    })
  }
}

/**
 * Returns true iff the given (already-normalized via getLoggingSafeMcpBaseUrl)
 * URL is in the official MCP registry. Undefined registry → false (fail-closed).
 */
export function isOfficialMcpUrl(normalizedUrl: string): boolean {
  return officialUrls?.has(normalizedUrl) ?? false
}

export function resetOfficialMcpUrlsForTesting(): void {
  officialUrls = undefined
}
