export type DesignOAuthSlot = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  clientId: string
}

export type DesignAuthFailureReason =
  | 'needs_design_login'
  | 'design_refresh_failed'
  | 'wrong_provider'
  | 'essential_traffic_only'
  | 'disabled'

export type DesignAuthResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: DesignAuthFailureReason; detail?: string }

export type DesignMcpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | Record<string, unknown>

export type DesignMcpTool = {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
  }
}
