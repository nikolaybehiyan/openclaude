/**
 * Teleported /ultrareview execution. Creates a CCR session with the current repo,
 * sends the review prompt as the initial message, and registers a
 * RemoteAgentTask so the polling loop pipes results back into the local
 * session via task-notification. Mirrors the /ultraplan → CCR flow.
 *
 * TODO(#22051): pass useBundleMode once landed so local-only / uncommitted
 * repo state is captured. The GitHub-clone path (current) only works for
 * pushed branches on repos with the Claude GitHub app installed.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { fetchUltrareviewQuota } from '../../services/api/ultrareviewQuota.js'
import { fetchUtilization } from '../../services/api/usage.js'
import type { TaskContext } from '../../Task.js'
import {
  checkRemoteAgentEligibility,
  formatPreconditionError,
  getRemoteTaskSessionUrl,
  registerRemoteAgentTask,
} from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import { isEnterpriseSubscriber, isTeamSubscriber } from '../../utils/auth.js'
import { detectCurrentRepositoryWithHost } from '../../utils/detectRepository.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getDefaultBranch, gitExe } from '../../utils/git.js'
import { teleportToRemote } from '../../utils/teleport.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import { escapeXml } from '../../utils/xml.js'
import { isUltrareviewEnabled } from './ultrareviewEnabled.js'

// One-time session flag: once the user confirms overage billing via the
// dialog, all subsequent /ultrareview invocations in this session proceed
// without re-prompting.
let sessionOverageConfirmed = false

export function confirmOverage(): void {
  sessionOverageConfirmed = true
}

export type OverageGate =
  | { kind: 'proceed'; billingNote: string }
  | { kind: 'not-enabled' }
  | { kind: 'low-balance'; available: number }
  | { kind: 'needs-confirm' }

export type UltrareviewLaunchResult =
  | { status: 'error'; message: string }
  | { status: 'blocked'; message: string; actionUrl: string | null }
  | { status: 'needs-confirm'; body: string; billingNote: string }
  | {
      status: 'launched'
      sessionId: string
      sessionUrl: string
      message: string
      billingNote: string
      taskId?: string
      title?: string
    }

type PreparedRemoteReview =
  | {
      kind: 'ready'
      mode: 'pr'
      prNumber: string
      repository: string
      target: string
      scope: string
    }
  | {
      kind: 'ready'
      mode: 'branch'
      baseBranch: string
      mergeBaseSha: string
      target: string
      scope: string
    }
  | { kind: 'blocked'; blocks: ContentBlockParam[] | null }

type RemoteReviewLaunchAttempt =
  | { launched: false; blocks: ContentBlockParam[] | null }
  | {
      launched: true
      blocks: ContentBlockParam[]
      sessionId: string
      sessionUrl: string
      taskId: string
      title: string
      message: string
    }

const BILLING_SETTINGS_URL = 'https://claude.ai/settings/billing'

function getReviewConfig(): Record<string, unknown> | null {
  return getFeatureValue_CACHED_MAY_BE_STALE<Record<string, unknown> | null>(
    'tengu_review_bughunter_config',
    null,
  )
}

export function getReviewCostNote(): string {
  const value = getReviewConfig()?.cost_note
  return typeof value === 'string' && value.length > 0 ? value : '$10-$20'
}

export function getReviewDurationNote(): string {
  const value = getReviewConfig()?.duration_note
  return typeof value === 'string' && value.length > 0
    ? value
    : '~10–20 min'
}

function blocksToText(blocks: ContentBlockParam[] | null): string {
  if (!blocks) return 'Failed to launch cloud review session.'
  return blocks
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Determine whether the user can launch an ultrareview and under what
 * billing terms. Fetches quota and utilization in parallel.
 */
export async function checkOverageGate(): Promise<OverageGate> {
  // Team and Enterprise plans include ultrareview — no free-review quota
  // or Extra Usage dialog. The quota endpoint is scoped to consumer plans
  // (pro/max); hitting it on team/ent would surface a confusing dialog.
  if (isTeamSubscriber() || isEnterpriseSubscriber()) {
    return { kind: 'proceed', billingNote: '' }
  }

  const [quota, utilization] = await Promise.all([
    fetchUltrareviewQuota(),
    fetchUtilization().catch(() => null),
  ])

  // No quota info (non-subscriber or endpoint down) — let it through,
  // server-side billing will handle it.
  if (!quota) {
    return { kind: 'proceed', billingNote: '' }
  }

  if (quota.reviews_remaining > 0) {
    return {
      kind: 'proceed',
      billingNote: ` This is free ultrareview ${quota.reviews_used + 1} of ${quota.reviews_limit}.`,
    }
  }

  // Utilization fetch failed (transient network error, timeout, etc.) —
  // let it through, same rationale as the quota fallback above.
  if (!utilization) {
    return { kind: 'proceed', billingNote: '' }
  }

  // Free reviews exhausted — check Extra Usage setup.
  const extraUsage = utilization.extra_usage
  if (!extraUsage?.is_enabled) {
    logEvent('tengu_review_overage_not_enabled', {})
    return { kind: 'not-enabled' }
  }

  // Check available balance (null monthly_limit = unlimited).
  const monthlyLimit = extraUsage.monthly_limit
  const usedCredits = extraUsage.used_credits ?? 0
  const available =
    monthlyLimit === null || monthlyLimit === undefined
      ? Infinity
      : monthlyLimit - usedCredits

  if (available < 10) {
    logEvent('tengu_review_overage_low_balance', { available })
    return { kind: 'low-balance', available }
  }

  if (!sessionOverageConfirmed) {
    logEvent('tengu_review_overage_dialog_shown', {})
    return { kind: 'needs-confirm' }
  }

  return {
    kind: 'proceed',
    billingNote: ' This review bills as Extra Usage.',
  }
}

async function prepareRemoteReview(
  args: string,
): Promise<PreparedRemoteReview> {
  const eligibility = await checkRemoteAgentEligibility()
  // Synthetic DEFAULT_CODE_REVIEW_ENVIRONMENT_ID works without per-org CCR
  // setup, so no_remote_environment isn't a blocker. Server-side quota
  // consume at session creation routes billing: first N zero-rate, then
  // anthropic:cccr org-service-key (overage-only).
  if (!eligibility.eligible) {
    const blockers = eligibility.errors.filter(
      e => e.type !== 'no_remote_environment',
    )
    if (blockers.length > 0) {
      logEvent('tengu_review_remote_precondition_failed', {
        precondition_errors: blockers
          .map(e => e.type)
          .join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const reasons = blockers.map(formatPreconditionError).join('\n')
      return {
        kind: 'blocked',
        blocks: [
          {
            type: 'text',
            text: `Ultrareview cannot launch:\n${reasons}`,
          },
        ],
      }
    }
  }

  const prNumber = args.trim()
  const isPrNumber = /^\d+$/.test(prNumber)
  if (isPrNumber) {
    const repo = await detectCurrentRepositoryWithHost()
    if (!repo || repo.host !== 'github.com') {
      logEvent('tengu_review_remote_precondition_failed', {})
      return { kind: 'blocked', blocks: null }
    }
    const repository = `${repo.owner}/${repo.name}`
    return {
      kind: 'ready',
      mode: 'pr',
      prNumber,
      repository,
      target: `${repository}#${prNumber}`,
      scope: `Reviewing PR ${repository}#${prNumber}`,
    }
  }

  const baseBranch = (await getDefaultBranch()) || 'main'
  const { stdout: mbOut, code: mbCode } = await execFileNoThrow(
    gitExe(),
    ['merge-base', baseBranch, 'HEAD'],
    { preserveOutputOnError: false },
  )
  const mergeBaseSha = mbOut.trim()
  if (mbCode !== 0 || !mergeBaseSha) {
    logEvent('tengu_review_remote_precondition_failed', {})
    return {
      kind: 'blocked',
      blocks: [
        {
          type: 'text',
          text: `Could not find merge-base with ${baseBranch}. Make sure you're in a git repo with a ${baseBranch} branch.`,
        },
      ],
    }
  }

  const { stdout: diffStat, code: diffCode } = await execFileNoThrow(
    gitExe(),
    ['diff', '--shortstat', mergeBaseSha],
    { preserveOutputOnError: false },
  )
  if (diffCode === 0 && !diffStat.trim()) {
    logEvent('tengu_review_remote_precondition_failed', {})
    return {
      kind: 'blocked',
      blocks: [
        {
          type: 'text',
          text: `No changes against the ${baseBranch} fork point. Make some commits or stage files first.`,
        },
      ],
    }
  }

  return {
    kind: 'ready',
    mode: 'branch',
    baseBranch,
    mergeBaseSha,
    target: baseBranch,
    scope: `Reviewing current branch against ${baseBranch}`,
  }
}

async function launchPreparedRemoteReview(
  prepared: Extract<PreparedRemoteReview, { kind: 'ready' }>,
  context: TaskContext,
  billingNote = '',
): Promise<RemoteReviewLaunchAttempt> {
  // Synthetic code_review env. Go taggedid.FromUUID(TagEnvironment,
  // UUID{...,0x02}) encodes with version prefix '01' — NOT Python's
  // legacy tagged_id() format. Verified in prod.
  const CODE_REVIEW_ENV_ID = 'env_011111111111111111111113'
  // Lite-review bypasses bughunter.go entirely, so it doesn't see the
  // webhook's bug_hunter_config (different GB project). These env vars are
  // the only tuning surface — without them, run_hunt.sh's bash defaults
  // apply (60min, 120s agent timeout), and 120s kills verifiers mid-run
  // which causes infinite respawn.
  //
  // total_wallclock must stay below RemoteAgentTask's 30min poll timeout
  // with headroom for finalization (~3min synthesis). Per-field guards
  // match autoDream.ts — GB cache can return stale wrong-type values.
  const raw = getReviewConfig()
  const posInt = (v: unknown, fallback: number, max?: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    const n = Math.floor(v)
    if (n <= 0) return fallback
    return max !== undefined && n > max ? fallback : n
  }
  // Upper bounds: 27min on wallclock leaves ~3min for finalization under
  // RemoteAgentTask's 30min poll timeout. If GB is set above that, the
  // hang we're fixing comes back — fall to the safe default instead.
  const commonEnvVars = {
    BUGHUNTER_DRY_RUN: '1',
    BUGHUNTER_FLEET_SIZE: String(posInt(raw?.fleet_size, 5, 20)),
    BUGHUNTER_MAX_DURATION: String(posInt(raw?.max_duration_minutes, 10, 25)),
    BUGHUNTER_AGENT_TIMEOUT: String(
      posInt(raw?.agent_timeout_seconds, 600, 1800),
    ),
    BUGHUNTER_TOTAL_WALLCLOCK: String(
      posInt(raw?.total_wallclock_minutes, 22, 27),
    ),
    ...(process.env.BUGHUNTER_DEV_BUNDLE_B64 && {
      BUGHUNTER_DEV_BUNDLE_B64: process.env.BUGHUNTER_DEV_BUNDLE_B64,
    }),
  }

  let session
  let command
  if (prepared.mode === 'pr') {
    // PR mode: refs/pull/N/head via github.com. Orchestrator --pr N.
    session = await teleportToRemote({
      initialMessage: null,
      description: `ultrareview: ${prepared.target}`,
      signal: context.abortController.signal,
      branchName: `refs/pull/${prepared.prNumber}/head`,
      environmentId: CODE_REVIEW_ENV_ID,
      environmentVariables: {
        BUGHUNTER_PR_NUMBER: prepared.prNumber,
        BUGHUNTER_REPOSITORY: prepared.repository,
        ...commonEnvVars,
      },
    })
    command = `/ultrareview ${prepared.prNumber}`
  } else {
    // Branch mode: bundle the working tree, orchestrator diffs against
    // the fork point. No PR, no existing comments, no dedup.
    session = await teleportToRemote({
      initialMessage: null,
      description: `ultrareview: ${prepared.baseBranch}`,
      signal: context.abortController.signal,
      useBundle: true,
      environmentId: CODE_REVIEW_ENV_ID,
      environmentVariables: {
        BUGHUNTER_BASE_BRANCH: prepared.mergeBaseSha,
        ...commonEnvVars,
      },
    })
    if (!session) {
      logEvent('tengu_review_remote_teleport_failed', {})
      return {
        launched: false,
        blocks: [
          {
            type: 'text',
            text: 'Repo is too large. Push a PR and use `/ultrareview <PR#>` instead.',
          },
        ],
      }
    }
    command = '/ultrareview'
  }

  if (!session) {
    logEvent('tengu_review_remote_teleport_failed', {})
    return { launched: false, blocks: null }
  }
  const { taskId, sessionId } = registerRemoteAgentTask({
    remoteTaskType: 'ultrareview',
    session,
    command,
    context,
    isRemoteReview: true,
  })
  logEvent('tengu_review_remote_launched', {})
  const sessionUrl = getRemoteTaskSessionUrl(sessionId)
  const message = `Ultrareview launched for ${prepared.target} (${getReviewDurationNote()}, runs in the cloud). Track: ${sessionUrl}${billingNote}`
  // Concise — the tool-output block is visible to the user, so the model
  // shouldn't echo the same info. Just enough for Claude to acknowledge the
  // launch without restating the target/URL (both already printed above).
  const blocks: ContentBlockParam[] = [
    {
      type: 'text',
      text: `${message} Findings arrive via task-notification. Briefly acknowledge the launch to the user without repeating the target or URL — both are already visible in the tool output above.`,
    },
  ]
  return {
    launched: true,
    blocks,
    sessionId,
    sessionUrl,
    taskId,
    title: session.title,
    message,
  }
}

/**
 * Interactive command adapter. Keeps the pre-existing command contract while
 * sharing the exact launch path with the SDK control request.
 */
export async function launchRemoteReview(
  args: string,
  context: TaskContext,
  billingNote?: string,
): Promise<ContentBlockParam[] | null> {
  const prepared = await prepareRemoteReview(args)
  if (prepared.kind === 'blocked') return prepared.blocks
  const attempt = await launchPreparedRemoteReview(
    prepared,
    context,
    billingNote,
  )
  return attempt.blocks
}

/** Native SDK control adapter used by Electron Local Code. */
export async function runUltrareviewHeadless(
  args: string,
  options: { confirm: boolean; context: TaskContext },
): Promise<UltrareviewLaunchResult> {
  if (!isUltrareviewEnabled()) {
    return { status: 'error', message: 'Ultrareview is currently unavailable.' }
  }

  const prepared = await prepareRemoteReview(args)
  if (prepared.kind === 'blocked') {
    return { status: 'error', message: blocksToText(prepared.blocks) }
  }

  const gate = await checkOverageGate()
  if (gate.kind === 'not-enabled') {
    return {
      status: 'blocked',
      message: 'Free ultrareviews used. Enable Extra Usage to continue.',
      actionUrl: BILLING_SETTINGS_URL,
    }
  }
  if (gate.kind === 'low-balance') {
    return {
      status: 'blocked',
      message: `Balance too low to launch ultrareview ($${gate.available.toFixed(2)} available, $10 minimum).`,
      actionUrl: BILLING_SETTINGS_URL,
    }
  }

  const billingNote =
    gate.kind === 'needs-confirm'
      ? `This review bills as usage credits (${getReviewCostNote()}).`
      : gate.billingNote.trim()

  if (!options.confirm) {
    return {
      status: 'needs-confirm',
      body: `${prepared.scope}\nEstimated duration: ${getReviewDurationNote()}. Estimated cost: ${getReviewCostNote()}.`,
      billingNote,
    }
  }

  if (gate.kind === 'needs-confirm') confirmOverage()
  const attempt = await launchPreparedRemoteReview(
    prepared,
    options.context,
    billingNote ? ` ${billingNote}` : '',
  )
  if (!attempt.launched) {
    return { status: 'error', message: blocksToText(attempt.blocks) }
  }
  return {
    status: 'launched',
    sessionId: attempt.sessionId,
    sessionUrl: attempt.sessionUrl,
    taskId: attempt.taskId,
    title: attempt.title,
    message: attempt.message,
    billingNote,
  }
}

/** Exact transcript mapping used by Claude Code's stream-json handler. */
export function buildUltrareviewOutcomeMessages(
  args: string,
  result: UltrareviewLaunchResult,
) {
  if (result.status === 'needs-confirm') return []
  const suffix = args ? ` ${escapeXml(args)}` : ''
  const command = createUserMessage({
    content: `<${COMMAND_NAME_TAG}>/ultrareview${suffix}</${COMMAND_NAME_TAG}>`,
    isMeta: true,
  })
  if (result.status === 'launched') {
    return [
      command,
      createUserMessage({
        content: `<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(result.message)}</${LOCAL_COMMAND_STDOUT_TAG}>`,
        isMeta: true,
      }),
    ]
  }
  const detail =
    result.status === 'blocked' && result.actionUrl
      ? `${result.message}\nMore: ${result.actionUrl}`
      : result.message
  return [
    command,
    createUserMessage({
      content: `<${LOCAL_COMMAND_STDERR_TAG}>Ultrareview did not launch: ${escapeXml(detail)}</${LOCAL_COMMAND_STDERR_TAG}>`,
      isMeta: true,
    }),
  ]
}
