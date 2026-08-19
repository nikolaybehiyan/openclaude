import {
  DESIGN_CONSENT_BIT,
  DESIGN_CONSENT_PATH,
  DESIGN_GRANTS_PATH,
} from './constants.js'
import { designJSONFetch } from './http.js'

export async function readDesignConsent(
  token: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const response = await designJSONFetch(DESIGN_CONSENT_PATH, token, {
    method: 'GET',
    signal,
  })
  if (!response.data || typeof response.data !== 'object') return undefined
  const value = (response.data as Record<string, unknown>)[DESIGN_CONSENT_BIT]
  return typeof value === 'boolean' ? value : undefined
}

export async function grantDesignConsent(
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  await designJSONFetch(DESIGN_CONSENT_PATH, token, {
    method: 'POST',
    body: { consent: DESIGN_CONSENT_BIT },
    signal,
  })
}

export async function revokeDesignConsent(
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  await designJSONFetch(DESIGN_CONSENT_PATH, token, {
    method: 'DELETE',
    body: { consent: DESIGN_CONSENT_BIT },
    signal,
  })
}

export async function readDesignProjectGrants(
  token: string,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  const response = await designJSONFetch(DESIGN_GRANTS_PATH, token, {
    method: 'GET',
    signal,
  })
  if (!response.data || typeof response.data !== 'object') return null
  const grants = (response.data as Record<string, unknown>).grants
  if (!Array.isArray(grants)) return null
  const ids = new Set<string>()
  for (const grant of grants) {
    if (
      grant &&
      typeof grant === 'object' &&
      typeof (grant as Record<string, unknown>).project_id === 'string'
    ) {
      ids.add((grant as Record<string, string>).project_id)
    }
  }
  return ids
}

export async function grantDesignProject(
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<void> {
  await designJSONFetch(DESIGN_GRANTS_PATH, token, {
    method: 'POST',
    body: { project_id: projectId },
    signal,
  })
}
