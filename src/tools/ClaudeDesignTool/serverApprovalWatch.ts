import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { resolveDesignAccessToken } from '../../services/design/auth.js'
import {
  DESIGN_GRANTS_PATH,
  DESIGN_GRANT_WATCH_FLAG,
} from '../../services/design/constants.js'
import { designJSONFetch } from '../../services/design/http.js'
import {
  registerServerApprovalWatchProvider,
  type ServerApprovalObserver,
  type ServerApprovalWatchProvider,
} from '../../hooks/toolPermission/serverApprovalWatch.js'
import type { ServerApprovalWatch } from '../../types/permissions.js'
import { logForDebugging } from '../../utils/debug.js'

type DesignGrantSnapshot =
  | { present: false }
  | { present: true; createdAtMs: number }

export type DesignGrantSnapshotReader = (
  projectId: string,
) => Promise<DesignGrantSnapshot | null>

export function parseDesignGrantSnapshot(
  projectId: string,
  data: unknown,
): DesignGrantSnapshot | null {
  if (!data || typeof data !== 'object') return null
  const grants = (data as Record<string, unknown>).grants
  if (!Array.isArray(grants)) return null
  for (const grant of grants) {
    if (!grant || typeof grant !== 'object') continue
    const record = grant as Record<string, unknown>
    if (record.project_id !== projectId) continue
    const createdAtMs =
      typeof record.created_at === 'string'
        ? Date.parse(record.created_at)
        : Number.NaN
    if (Number.isNaN(createdAtMs)) return null
    return { present: true, createdAtMs }
  }
  return { present: false }
}

async function readDesignGrantSnapshot(
  projectId: string,
): Promise<DesignGrantSnapshot | null> {
  try {
    const auth = await resolveDesignAccessToken()
    if (!auth.ok) return null
    const response = await designJSONFetch(
      DESIGN_GRANTS_PATH,
      auth.accessToken,
      { method: 'GET', allowHTTPError: true },
    )
    if (response.status !== 200) return null
    return parseDesignGrantSnapshot(projectId, response.data)
  } catch {
    logForDebugging(
      'Server-approval watcher poll failed; will poll again.',
    )
    return null
  }
}

export function createDesignProjectGrantObserver(
  projectId: string,
  readSnapshot: DesignGrantSnapshotReader = readDesignGrantSnapshot,
): ServerApprovalObserver {
  let baseline: { createdAtMs: number | null } | null = null
  return {
    async poll(): Promise<boolean> {
      const snapshot = await readSnapshot(projectId)
      if (snapshot === null) return false
      if (baseline === null) {
        baseline = {
          createdAtMs: snapshot.present ? snapshot.createdAtMs : null,
        }
        return false
      }
      if (!snapshot.present) return false
      if (
        baseline.createdAtMs !== null &&
        snapshot.createdAtMs <= baseline.createdAtMs
      ) {
        return false
      }
      return true
    },
  }
}

export const designServerApprovalWatchProvider: ServerApprovalWatchProvider = {
  isEnabled(): boolean {
    return getFeatureValue_CACHED_MAY_BE_STALE(
      DESIGN_GRANT_WATCH_FLAG,
      false,
    )
  },
  createObserver(
    descriptor: ServerApprovalWatch,
  ): ServerApprovalObserver | null {
    return descriptor.kind === 'design_project_grant' &&
      typeof descriptor.projectId === 'string' &&
      descriptor.projectId.length > 0
      ? createDesignProjectGrantObserver(descriptor.projectId)
      : null
  },
}

registerServerApprovalWatchProvider(designServerApprovalWatchProvider)
