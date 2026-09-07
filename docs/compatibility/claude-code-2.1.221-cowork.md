# Cowork compatibility: pinned Claude Code 2.1.221

Checked 2026-09-07. This is a bounded source port, not a full Cowork E2E pass.

## Reference, not a moving SDK version

Preserved binary (read-only):
`/Users/begiyan/Desktop/code/downloaded_builds/helpers/claude-code/2.1.221/darwin-arm64/claude`

- `--version`: `2.1.221 (Claude Code)`.
- Size: 270,518,240 bytes.
- SHA-256: `7a181f36ed0fc4fbac6cee4ecf2b615eff93d8b434221fff5d7c878dc5ebf380`.
- Embedded initialize schema accepts `systemPrompt` as an array of strings.
- Embedded prompt selector `fce` distinguishes a string, an array and an absent
  custom prompt. It preserves the supplied array as separate ordered sections.
- The same binary contains the initialize fields `appendSubagentSystemPrompt`,
  `planModeInstructions`, `toolAliases` and `excludeDynamicSections` and their
  execution consumers. Thus these are not inferred solely from the newer
  `0.3.222` SDK bundled in the inspected Desktop ASAR.

The Desktop already builds capability-dependent Local Cowork sections and passes
them through initialize. Receiving them correctly is different from rewriting
the Desktop's product instructions in the backend. A CLI binary is also not the
whole control plane: device grants, connector authorization and durable file
delivery require host/service implementations.

## Implemented first port

OpenClaude baseline: `6864979b8830e22cf1e878b3592926322d492fdf`.

The baseline wrapped an incoming section array in another array and narrowed it
to undefined in QueryEngine context preparation. This could both produce the
wrong provider request shape and select ordinary Code context for a supplied
Cowork prompt.

The port preserves sections through:

1. initialize schema and headless option types;
2. public SDK query and persistent session entrypoints/declarations;
3. QueryEngine context selection and prompt assembly;
4. normal effective-prompt selection, context inspection and side-question
   fallback;
5. the existing API system-block/cache-boundary conversion.

Legacy string callers remain supported. Explicit empty strings/arrays remain
overrides, as in the reference; an absent prompt retains the Code default.
Agent/override precedence is unchanged. Project appends remain separate. No
permissions, connectors, account prompts or feature gates are changed.

The external type regression also exposed a pre-existing unresolved
`CanUseToolCallback` name in the declaration of the memory helper. Its return
type now uses the existing public permission callback type via
`NonNullable<QueryOptions['canUseTool']>`; runtime permissions are unchanged.

## Verification

- `bun test tests/sdk/system-prompt-sections.test.ts tests/sdk/generated-types.test.ts`
  — 27 pass. Actual prompt assembly and side-question context functions are
  exercised in an isolated process, with no model calls or builds.
- `bun test tests/sdk/query-methods.test.ts tests/sdk/sdk-v2-lifecycle.test.ts -t 'multipart|custom system prompt|custom sections'`
  — 4 pass. Real SDK constructors retain sections in their engine configuration.
- `bun test tests/sdk/package-consumer-types.test.ts -t 'package consumer types'`
  — 3 pass, external TypeScript consumer with `skipLibCheck:false`.
- `bun test src/utils/api.test.ts src/constants/promptIdentity.test.ts`
  — 9 pass. Provider-boundary block conversion accepts the assembled sections,
  preserves order and removes the internal cache marker; Code identity tests
  remain green.

Total: 43 focused tests, no live deployment, no paid/model E2E, no Docker build.
This is not a full repository typecheck or complete protocol parity claim.

## Still to port/verify separately

- Subagent prompt propagation and its reference environment gate.
- Plan workflow customization while retaining read-only/exit-plan enforcement.
- Single-hop tool aliases through execution **and** permissions, not only model
  display names.
- Dynamic-section exclusion/reinjection for preset prompts; reference says it
  has no effect on a fully custom prompt.
- Real cloud file delivery, artifacts, scheduling and device adapters, bound to
  the exact user/org/project grants. Do not invent tools in prompt text.
- Frontend Progress/Outputs/Context and project linkage; interactive, resumed
  and scheduled sessions must be tested independently.

## Local vs cloud: current public evidence

[Anthropic's architecture description](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)
distinguishes local device/VM execution from cloud sandboxes. Cloud access to
local files/browser is mediated by an online Desktop and folder permissions;
connector authorization stays server-side. These docs describe current product
architecture, not a published 2.1.221 internal implementation.

[The supported-surface matrix](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)
lists connectors, skills/plugins, projects and schedules across cloud surfaces.
The [schedule documentation](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
describes autonomous scheduled Cowork runs.

Implementation conclusion (inference): share the Cowork task workflow and engine
contracts; vary execution, filesystem/device permissions, persistence and
delivery adapters. Do not replace cloud Cowork with repository/commit-oriented
Code instructions. Current docs and third-party prompt captures are supporting
evidence; version-specific runtime behavior is pinned to the preserved binary.
