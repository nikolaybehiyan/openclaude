# Public Workflow adapter

The open CLI/SDK build now enables `WORKFLOW_SCRIPTS`. The public adapter
registers the Workflow tool, approval dialog, task details, `/workflows`, saved
workflow commands, plugin discovery and the `/config` controls. The rollout
gate, organization policy, environment disable and explicit user opt-in still
apply. Workflow children inherit the ordinary tool permission pipeline;
classifier errors cannot grant permission.

Implemented public behavior:

- Review the script and metadata phases, switch to raw source, edit in `$EDITOR`,
  approve once or remember a named workflow, or reject with feedback. Execution
  uses the reviewed bytes, including when the original file changes.
- Inspect agents, phases, results, tokens and tool calls; stop, pause, skip or
  retry agents. Resume uses the existing durable journal and exclusive lease.
- Save a workflow to the enabled project/user setting source, confirm an
  overwrite, and refresh slash commands without restarting the CLI.
- Discover flat `.js` workflows from enabled plugins, project ancestors and
  user settings. Plugin names are namespaced; explicit `workflows` or
  `experimental.workflows` paths replace the default plugin directory.
- Persist bounded private history snapshots at launch and completion. Reloaded
  running snapshots display as paused; history never grants a live lease.
- Configure Dynamic workflows, keyword opt-in and size guidelines. User
  disable/re-enable refreshes commands; managed disable remains authoritative.
- Add the pinned keyword, Ultracode enter/exit/maintenance and size-change
  reminders only for the appropriate main-conversation input. Expanded skills,
  tool output and child agents cannot supply user opt-in.

The bundled `code-review` and `deep-research` scripts and base tool prompt stay
byte-exact against Claude Code 2.1.226. `code-review` is hidden from slash
discovery, as in the pinned metadata, but remains a named Workflow scenario.
`deep-research` has a visible explicit slash command; its independent gate
controls model-initiated discovery. The web Chat research toggle is separate.

Validation on 2026-09-27: 152 focused Workflow/policy/runtime/UI tests and 27
goal tests passed. The pinned binary/template/prompt checks read the reference
without executing it. `scripts/test-public-workflow.mjs` exercises the built
CLI through a local inference fixture: actual tool registration, a real child
query, task output and persisted history. `--slash` additionally checks saved
workflow discovery and slash expansion. These fixtures do not prove live
provider inference or public deployment.

Release acceptance is tracked separately. The already frozen Desktop
1.26832.20 family predates this activation. A subsequent consistent native,
SDK, service and Desktop family must carry this source change before PROD
can expose it. Interactive Mac acceptance and live provider execution remain
required; no all-platform or 100% behavioral-parity claim is made here.

Known scope limits: history is checkpointed at launch/completion, not on every
progress event; scripts without metadata phases show their source for approval
instead of inferred static phases. Repository-wide TypeScript checking has
pre-existing errors outside this adapter and is not a clean validation signal.
