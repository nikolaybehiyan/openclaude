import { randomBytes } from 'crypto'
import { realpath } from 'fs/promises'
import path from 'path'
import {
  DESIGN_MAX_GLOB_WILDCARDS,
  DESIGN_MAX_PATH_BYTES,
} from '../../services/design/constants.js'

type Plan = {
  projectId: string
  writes: string[]
  deletes: string[]
  localDir?: string
}

const plans = new Map<string, Plan>()

export function normalizeDesignPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment !== '' && segment !== '.')
    .join('/')
}

export function isReservedDesignPath(value: string): boolean {
  const normalized = normalizeDesignPath(value).toLowerCase()
  return (
    normalized === 'claude.md' ||
    normalized.startsWith('claude.md/') ||
    normalized === '.claude' ||
    normalized.startsWith('.claude/')
  )
}

export function assertSafeDesignPath(value: string): string {
  const normalized = normalizeDesignPath(value)
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > DESIGN_MAX_PATH_BYTES ||
    normalized.split('/').includes('..') ||
    normalized.includes('\0')
  ) {
    throw new Error(`Invalid project path: ${value}`)
  }
  return normalized
}

function globRegex(glob: string): RegExp {
  let output = ''
  let index = 0
  let wildcards = 0
  const countWildcard = () => {
    wildcards += 1
    if (wildcards > DESIGN_MAX_GLOB_WILDCARDS) {
      throw new Error(
        `glob "${glob}" exceeds ${DESIGN_MAX_GLOB_WILDCARDS} '*'/'**' wildcards`,
      )
    }
  }
  while (index < glob.length) {
    const char = glob[index]!
    if (char === '*' && glob[index + 1] === '*') {
      countWildcard()
      if (glob[index + 2] === '/') {
        output += '(?:.*/)?'
        index += 3
      } else {
        output += '.*'
        index += 2
      }
    } else if (char === '*') {
      countWildcard()
      output += '[^/]*'
      index += 1
    } else if (char === '?') {
      countWildcard()
      output += '[^/]'
      index += 1
    } else {
      output += /[.+^$|()[\]{}\\]/.test(char) ? `\\${char}` : char
      index += 1
    }
  }
  return new RegExp(`^${output}$`)
}

export function pathAllowedByPlan(value: string, patterns: string[]): boolean {
  const normalized = assertSafeDesignPath(value)
  for (const rawPattern of patterns) {
    const pattern = normalizeDesignPath(rawPattern)
    if (/[*?]/.test(pattern)) {
      if (globRegex(pattern).test(normalized)) return true
    } else if (pattern === normalized) {
      return true
    }
  }
  return false
}

export async function registerDesignPlan(input: Plan): Promise<string> {
  const localDir = input.localDir
    ? await realpath(path.resolve(input.localDir))
    : await realpath(process.cwd())
  const writes = input.writes.map(normalizeDesignPath)
  const deletes = input.deletes.map(normalizeDesignPath)
  for (const pattern of [...writes, ...deletes]) {
    assertSafeDesignPath(pattern.replace(/[*?]/g, 'x'))
    if (/[*?]/.test(pattern)) globRegex(pattern)
  }
  const prefix =
    input.projectId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) ||
    'anon'
  const id = `plan_${prefix}_${randomBytes(6).toString('hex')}`
  plans.set(id, { projectId: input.projectId, writes, deletes, localDir })
  return id
}

export function requireDesignPlan(
  planId: string,
  projectId: string,
): Plan {
  if (!/^plan_[a-z0-9]{1,16}_[a-f0-9]{12}$/.test(planId)) {
    throw new Error(
      'Plan token is missing or does not match this project. Call finalize_plan first.',
    )
  }
  const plan = plans.get(planId)
  if (!plan || plan.projectId !== projectId) {
    throw new Error(
      'Plan token is missing or does not match this project. Call finalize_plan first.',
    )
  }
  return plan
}

export function resetDesignPlansForTests(): void {
  plans.clear()
}
