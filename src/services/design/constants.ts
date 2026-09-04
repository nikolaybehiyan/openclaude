import { getOauthConfig, DESIGN_OAUTH_SCOPES } from '../../constants/oauth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export { DESIGN_OAUTH_SCOPES }

export const DESIGN_RPC_SERVICE =
  'anthropic.omelette.api.v1alpha.OmeletteService'
export const DESIGN_PROJECT_TYPE = 'PROJECT_TYPE_DESIGN_SYSTEM'
export const DESIGN_SYNC_CLIENT = 'claude-cli-design-sync'
export const DESIGN_MCP_CLIENT = 'claude-cli-design-tool'
export const DESIGN_MCP_PROTOCOL_VERSION = '2025-03-26'
export const DESIGN_MCP_PATH = '/v1/design/mcp'
export const DESIGN_CONSENT_PATH = '/v1/design/consent'
export const DESIGN_GRANTS_PATH = '/v1/design/grants'
export const DESIGN_CONSENT_BIT = 'agent_design_projects'
export const DESIGN_REQUEST_TIMEOUT_MS = 60_000
export const DESIGN_LOGIN_TIMEOUT_MS = 300_000
export const DESIGN_MAX_BODY_BYTES = 32 * 1024 * 1024
export const DESIGN_MCP_AGGREGATE_RESULT_CHARS = 130_000
export const DESIGN_MCP_MAX_CONTENT_BYTES = 16 * 130_000
export const DESIGN_MAX_PATH_BYTES = 256
export const DESIGN_MAX_BATCH = 256
export const DESIGN_MAX_LOCAL_FILE_BYTES = 12 * 1024 * 1024
export const DESIGN_MAX_GLOB_WILDCARDS = 3
export const DESIGN_PLAN_TTL_MS = 15 * 60 * 1000
export const DESIGN_FEATURE_FLAG = 'tengu_omelette_fouet'
export const DESIGN_GRANT_WATCH_FLAG = 'tengu_omelette_grant_watch'

export const DESIGN_TEXT_EXTENSIONS = new Set([
  'html',
  'css',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'json',
  'svg',
  'xml',
  'md',
  'txt',
  'csv',
  'yaml',
  'yml',
  'toml',
])

export function designBaseURL(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const hostedBase = environment.CLAUDE_CODE_DESIGN_API_URL?.trim()
  if (
    hostedBase &&
    isEnvTruthy(environment.CLAUDE_CODE_REMOTE) &&
    environment.CLAUDE_CODE_REMOTE_SESSION_ID?.trim()
  ) {
    try {
      const parsed = new URL(hostedBase)
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash &&
        (parsed.pathname === '' || parsed.pathname === '/')
      ) {
        return parsed.origin
      }
    } catch {
      // Ignore malformed host-owned configuration and keep the public route.
    }
  }
  return getOauthConfig().BASE_API_URL.replace(/\/$/, '')
}
