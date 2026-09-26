# Public Workflow adapter: preserved, not enabled

The previously untracked `WorkflowTool.ts` and pinned `prompt.ts` are preserved
in the shared source branch with adapter regression tests. The build flag
`WORKFLOW_SCRIPTS` is unchanged and remains disabled. This commit does not claim
that Ultracode is usable, visible, or fully equivalent to Claude Code 2.1.226.

The adapter fixes its invocation ID to the actual `ToolUseContext.toolUseId`
contract and rejects hidden C0/C1 characters other than tab and newline in
approval text. Tests cover input bounds, disabled direct invocation, aborts,
tombstones, summaries/results and the pinned prompt hash. No live inference,
new provider permissions or release publication is performed by these tests.

Before enabling Ultracode, finish and independently verify the public approval
and detail UI, `/workflows` and create-workflow commands, plugin discovery,
output schema and prompt additions, then actual multi-agent execution,
permissions, cancellation, pause/resume and token-budget enforcement. Keep
the existing explicit opt-in rule. A build containing these dormant files is
not evidence that any of those remaining acceptance checks has passed.

Repository-wide TypeScript checking currently reports errors outside this
adapter; focused tests must not be represented as a clean full typecheck.

Validation on 2026-09-26: 124 workflow/policy/source-guard tests passed; the
optional upstream binary check was skipped in that suite and then run
explicitly, with all eight adapter tests passing. The read-only upstream check
verifies the complete binary hash, template hash, seven literal substitutions
and final prompt equality without executing upstream code. Template-source
and rendered-prompt hashes are different and are recorded separately.
