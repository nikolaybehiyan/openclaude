# Standalone Darb CLI: managed model catalog

The `darb` entry point uses Darb account authentication. In Customize → Connections,
the user (or organization administrator) chooses the **CLI** default from an
authorized gateway. The CLI never receives the gateway credential or underlying
OpenAI/DeepSeek/GLM provider keys.

The CLI loads `GET /v1/models?limit=1000` before resolving its initial model,
including in `--bare`/print mode. That endpoint must implement the saved-selection
contract from the Identity owner. A legacy alias catalog is **not** a usable
connection. No configured selection means **Connect AI**, not Sonnet/Opus or an
implicit first model. A catalog fetch failure, denied organization policy and
expired sign-in have separate messages.

`/model` loads current authorized models; `/model refresh` reloads the catalog.
Models are displayed and sent with exact case, namespaces and suffixes. The
default/fast/quality helpers use the approved CLI default; built-in agents inherit
the parent's real selection. Custom agent overrides must be exact available IDs.
Only the Agent tool's optional model selector is generalized for this entry point;
Ask User, artifacts, other tool schemas and prompts are not rewritten.

Reasoning and supported effort levels come from the catalog, not model-name
heuristics. The existing native picker/theme is reused. The connection ID,
connection revision and catalog digest are frozen when constructing a request.
The HTTP guard checks model identity and destination, replaces untrusted binding
headers and forbids redirects. Identity still authorizes each inference request.

The catalog is memory-only and scoped to origin/account/organization. A failed
refresh clears it; stale asynchronous responses cannot restore an older catalog.
Changing account prevents reuse of a constructed client's binding. A model-setting
string from another provider never authorizes a Darb request.

The native JSONL transcript also keeps a `darb-inference-binding` metadata entry:
version, a hash of origin/account/organization, connection ID and connection
revision. This is only a destination selector, not a credential or cached grant.
Every model's catalog digest and current permissions are still checked separately
on every request, so approved helper models on the same connection remain usable.

Resume/continue/path-based loading, forks and pre-compaction metadata recovery
preserve the selector. A changed account, organization, connection or connection
revision cannot silently reroute old history. Legacy/malformed transcripts require
an explicit choice in `/model`; `/model refresh` alone does not authorize migration.
Select in interactive mode before reusing such a transcript from `--print`.
`/clear` starts a fresh binding. Binding metadata is flushed before inference when
a transcript exists; fresh sessions use native lazy materialization. Persistence
disabled means memory-only enforcement. Write failures stop inference. An already
constructed HTTP client also rechecks account and session after async preflight.

This path is enabled by the launcher-owned `DARB_CLI_MANAGED_INFERENCE=1` switch
and the existing trusted Darb control/inference origin. Embedded SDK/remote runtime
sessions and third-party profiles are excluded: their caller owns their frozen
model contract. No upstream synchronization is required.

## Verification and remaining acceptance

Run test files in separate Bun processes because the existing test harness uses
process-global module mocks. Use an isolated `CLAUDE_CONFIG_DIR` for regression
tests that write settings:

- `src/utils/model/darbCatalog.test.ts` — 8 tests, including an actual Anthropic
  SDK client with a local fetch fixture preserving system/tools/message payloads.
- `src/utils/model/darbModels.test.ts` — 6 model/helper/agent/effort/identity tests.
- `src/services/api/darbModels.test.ts` — 5 authenticated catalog/failure tests.
- Existing OAuth routing (7), shim models (14), agent routing (20) tests pass.
- `src/utils/model/darbSessionBinding.test.ts` — 10 tests: native disk round-trip,
  a separate-process restart, all full log loading paths, changed identities and
  gateways, legacy/invalid data, explicit selection, fork/clear, no persistence,
  large pre-compaction recovery, storage errors and transport fencing.
- Existing transcript persistence tests — 5 pass. Total focused suite: 75 pass.

The branded CLI/SDK build and `darb --version` smoke pass. The repository-wide
TypeScript check still has 1,723 diagnostics; comparing normalized diagnostics
against HEAD in memory added **zero** diagnostics (no worktree or source rollback).
This is not a claim that the full typecheck passes.

Not yet established: a live configured gateway inference in the installed CLI,
TUI acceptance after deployment, concurrent independent writers to one transcript,
numeric context/output limits and pricing for arbitrary models, or all
specialized helper/capability paths. The server still retains its unconfigured
legacy SDK branch for unmigrated clients; this standalone client refuses that
branch. Other Darb surfaces require their own migration and acceptance. This is
not 100% model-agnostic product parity.
