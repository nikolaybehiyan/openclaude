# Claude Tag parity evidence (Claude Code 2.1.221)

This module is an additive implementation of the Claude Tag contracts recovered
from the Claude Code 2.1.221 Darwin arm64 executable. It activates only when the
host supplies `CLAUDE_MEMORY_STORES`; ordinary OpenClaude auto-memory and repo
team-memory remain on their existing paths.

## Primary artifact

- File: `downloaded_builds/helpers/claude-code/2.1.221/darwin-arm64/claude`
- Reported version: `2.1.221 (Claude Code)`
- SHA-256: `7a181f36ed0fc4fbac6cee4ecf2b615eff93d8b434221fff5d7c878dc5ebf380`
- Size: 270,518,240 bytes

The artifact is read-only. No hidden prompt body or classifier threshold has
been invented. Relevant recovered regions include the store parser and memory
backend near byte 241,383,769, the memory prompt and index compositor near byte
241,458,133, relay metadata handling near byte 256,122,900, and queue batching
near byte 259,972,900.

## Proven and implemented

- `CLAUDE_MEMORY_STORES` validation, defaults, mount uniqueness, at most one
  user store, safe prompt indexes, and safe memory-provided skill directories.
- User memory at the private memory root and team memory at
  `team/<mount>`, with `.memory-sync` and `.memory-sync-basis` version 1.
- Pull/push SHA basis, optimistic update/create conflicts, same-path create
  race recovery, read-only restoration, conservative corroborated deletes,
  mass-delete hold, permanent-rejection suppression, and periodic resync.
- The 102,400-byte file cap and `.md`, `.txt`, `.json`, `.jsonl` allowlist,
  hidden-path exclusion, secret scanning, symlink rejection for memory skills,
  six-way I/O concurrency, 2.5-second first-pull deadline, and 60-minute
  default resync interval.
- The recovered file-memory system instructions, `MEMORY.md` 200-line / 25,000
  character splice, read-only instructions, reference-data envelope, optional
  `<cc-memory>` citation gate, and project-skill upkeep gate.
- Verified Slack/Teams relay origin pairs, relay priority state machine, exact
  busy-turn prefix, `shouldQuery`, homogeneous batching rules, printable
  128-byte CCR turn IDs, and per-turn `X-CCR-Turn-Id` propagation to
  session-ingress MCP requests.

## Deliberate compatibility boundary

- With no `CLAUDE_MEMORY_STORES`, the module is inert. Existing OpenClaude
  auto-memory, extract-memory, auto-dream, and repo team-memory behavior is
  unchanged.
- With explicit Tag stores, legacy extract/auto-dream and the legacy team
  watcher are disabled for that session so two independent writers cannot
  mutate the same projection.

## Remaining integration evidence

- 2.1.221 also has bulk NDJSON export paths. This implementation uses the same
  memory-service records through bounded paginated listing; behavior is
  equivalent for the projected files, but bulk-export performance parity is
  not claimed.
- The current Telegram Code-service must actually pass the verified relay
  metadata (`client_platform`, `inbound_origin`, `turn_id`, `shouldQuery`) and
  the server-resolved `CLAUDE_MEMORY_STORES` snapshot into the OpenClaude
  process. Without that host signal, the native relay/CCR branch is correctly
  inactive.
- Source and unit evidence are not live evidence. Install-to-Telegram E2E,
  memory-service persistence, reconnect, conflict, revoke, and pod-log proof
  are still required before declaring full live parity.

## Public corroboration (not used for hidden details)

- Official Claude Code memory documentation:
  <https://code.claude.com/docs/en/memory>
- Official Claude in Slack documentation:
  <https://code.claude.com/docs/en/slack>
- Anthropic Claude Tag product page: <https://claude.com/product/tag>
- Secondary reverse engineering:
  <https://pluto.security/blog/inside-claude-tag-how-anthropics-slack-native-agent-actually-works/>
