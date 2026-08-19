import { DESIGN_PLAN_TTL_MS } from '../../services/design/constants.js'
import type { DesignMcpContent } from '../../services/design/types.js'
import {
  assertSafeDesignPath,
  isReservedDesignPath,
} from '../DesignSyncTool/plan.js'

type ApprovedPlan = {
  projectId: string
  writes: Set<string>
  deletes: Set<string>
  expiresAt: number
}

const approvedPlans = new Map<string, ApprovedPlan>()

export type TokenlessWriteTargets =
  | { outcome: 'pass'; targets: string[] }
  | { outcome: 'empty' | 'reserved_or_unrenderable' }

/**
 * 2.1.221 only offers a durable whole-project grant when every target can be
 * enumerated faithfully in the approval flow. Instruction-bearing paths stay
 * on the explicit per-batch finalize_plan boundary even after a grant exists.
 */
export function tokenlessWriteTargets(
  operation: string,
  args: Record<string, unknown>,
): TokenlessWriteTargets {
  let candidates: unknown[]
  if (operation === 'write_files') {
    if (!Array.isArray(args.files)) {
      return { outcome: 'reserved_or_unrenderable' }
    }
    candidates = args.files.map(file =>
      file && typeof file === 'object' && !Array.isArray(file)
        ? (file as Record<string, unknown>).path
        : undefined,
    )
  } else if (operation === 'create_support_js') {
    candidates = [
      typeof args.path === 'string' && args.path ? args.path : 'support.js',
    ]
  } else {
    return { outcome: 'reserved_or_unrenderable' }
  }
  if (candidates.length === 0) return { outcome: 'empty' }
  if (candidates.length > 256) {
    return { outcome: 'reserved_or_unrenderable' }
  }
  try {
    const targets = candidates.map(value => {
      if (typeof value !== 'string') throw new Error('non-string target')
      return assertSafeDesignPath(value)
    })
    if (targets.some(isReservedDesignPath)) {
      return { outcome: 'reserved_or_unrenderable' }
    }
    return { outcome: 'pass', targets }
  } catch {
    return { outcome: 'reserved_or_unrenderable' }
  }
}

function parseJSONContent(content: DesignMcpContent[]): Record<string, unknown> | null {
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    try {
      const parsed = JSON.parse(block.text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Keep looking for the server's structured text block.
    }
  }
  return null
}

export function recordApprovedMcpPlan(
  args: Record<string, unknown>,
  content: DesignMcpContent[],
): void {
  const result = parseJSONContent(content)
  const token = result?.plan_token
  const projectId = args.project_id
  if (
    typeof token !== 'string' ||
    !token ||
    typeof projectId !== 'string' ||
    !projectId
  ) {
    return
  }
  const writes = Array.isArray(args.writes)
    ? args.writes.filter((value): value is string => typeof value === 'string')
    : []
  const deletes = Array.isArray(args.deletes)
    ? args.deletes.filter((value): value is string => typeof value === 'string')
    : []
  const expiresAtSeconds = result.expires_at
  const serverExpiry =
    typeof expiresAtSeconds === 'number' && Number.isFinite(expiresAtSeconds)
      ? expiresAtSeconds * 1000
      : undefined
  approvedPlans.set(token, {
    projectId,
    writes: new Set(writes.map(assertSafeDesignPath)),
    deletes: new Set(deletes.map(assertSafeDesignPath)),
    expiresAt: Math.min(
      serverExpiry ?? Date.now() + DESIGN_PLAN_TTL_MS,
      Date.now() + DESIGN_PLAN_TTL_MS,
    ),
  })
}

function targetPaths(
  operation: string,
  args: Record<string, unknown>,
): { set: 'writes' | 'deletes'; paths: string[] } | null {
  if (operation === 'write_files') {
    if (!Array.isArray(args.files)) return null
    const paths = args.files.map(file =>
      file && typeof file === 'object'
        ? (file as Record<string, unknown>).path
        : undefined,
    )
    return paths.every((value): value is string => typeof value === 'string')
      ? { set: 'writes', paths }
      : null
  }
  if (operation === 'copy_files') {
    if (!Array.isArray(args.files)) return null
    const paths = args.files.map(file =>
      file && typeof file === 'object'
        ? (file as Record<string, unknown>).dest
        : undefined,
    )
    return paths.every((value): value is string => typeof value === 'string')
      ? { set: 'writes', paths }
      : null
  }
  if (operation === 'create_support_js') {
    return {
      set: 'writes',
      paths: [typeof args.path === 'string' && args.path ? args.path : 'support.js'],
    }
  }
  if (operation === 'delete_files') {
    if (args.paths !== undefined && args.files !== undefined) return null
    if (Array.isArray(args.paths)) {
      return args.paths.every(
        (value): value is string => typeof value === 'string',
      )
        ? { set: 'deletes', paths: args.paths }
        : null
    }
    if (Array.isArray(args.files)) {
      const paths = args.files.map(file =>
        file && typeof file === 'object'
          ? (file as Record<string, unknown>).path
          : undefined,
      )
      return paths.every((value): value is string => typeof value === 'string')
        ? { set: 'deletes', paths }
        : null
    }
  }
  return null
}

export function approvedMcpPlanAllows(
  operation: string,
  args: Record<string, unknown>,
): boolean {
  const token = args.plan_token
  const projectId = args.project_id
  if (typeof token !== 'string' || typeof projectId !== 'string') return false
  const plan = approvedPlans.get(token)
  if (!plan || plan.projectId !== projectId || Date.now() >= plan.expiresAt) {
    approvedPlans.delete(token)
    return false
  }
  const targets = targetPaths(operation, args)
  if (!targets || targets.paths.length === 0 || targets.paths.length > 256) {
    return false
  }
  const allowed = targets.set === 'writes' ? plan.writes : plan.deletes
  try {
    return targets.paths.every(value => allowed.has(assertSafeDesignPath(value)))
  } catch {
    return false
  }
}

export function resetApprovedMcpPlansForTests(): void {
  approvedPlans.clear()
}
