# Design sync source checkpoint — 2026-09-05

Status: **source/local converter checks passed; authenticated Web sync not yet verified**.
No Docker image build, import, runtime rollout, or Kubernetes apply was performed
for this checkpoint. The coordinating runtime task's HOLD remains in effect.

## Corrected discrepancy

The previous `/design-sync` command advertised a React/Storybook converter but
contained only transport-tool instructions. The official Claude Code 2.1.221
command supplies a main skill plus 25 reference/script files. Those assets are
now restored with exact binary provenance, lazy extraction, original filenames,
and no automatic approval of the write-capable tool.

See `src/services/design/PROVENANCE.md` and the per-file SHA-256/offset manifest
under `src/skills/bundled/design-sync/` for reproducible extraction evidence.
The protected source binary in `downloaded_builds` was only read.

## Verified

- 47 focused tests passed across commands, shared bundled-skill extraction,
  OAuth, gates, native MCP, direct RPC, and permission boundaries.
- All 26 asset hashes match the audited extraction. All 23 executable resources
  parse with Node. A small Bun bundle preserves every asset byte as inert text.
- The real one-component React 19.2.4 package fixture converted successfully:
  `_ds_bundle.js`, CSS import closure, component card, declarations and usage
  document, vendor runtime, and `_ds_sync.json`.
- Structural validation passed before and after changing the component bundle.
  The unchanged-anchor diff requests no upload; changed compiled code requests
  bundle/styling upload. The anchor used here is a local test artifact, not a
  receipt from a remote upload.
- IAB opened the locally served generated `ParityButton.html` and visibly
  rendered a styled green React button with `DESIGN_SYNC_COMPONENT_UPDATED`.
  This was a local render check, not an authenticated Web sync.
- The separate Storybook adapter passed a minimal, hand-authored prebuilt-index
  fixture: three story exports paired, docs excluded, preview decorator bundled,
  and story-local custom-render closure preserved. Structural validation passed
  before and after editing the story. The unchanged anchor requests no upload;
  the story edit invalidates `ParityButton` verification and requests upload.
- IAB rendered that generated Storybook card with `STORYBOOK_PRIMARY_PASS`, a
  genuinely disabled `STORYBOOK_DISABLED_PASS` button, and the updated custom
  story `STORYBOOK_CUSTOM_UPDATED`, all with the fixture styling. This tests the
  converter's Storybook-index path, not a full Storybook build or a comparison
  against a reference Storybook app. The temporary preview server was stopped
  after inspection; the production Design tab was left unchanged.
- The existing authenticated Design project
  `81c23a83-67fa-469c-970f-2338f6fac8ae` still displayed
  `DESIGN_IAB_PASS_20260905` in its preview iframe in IAB. It was created by the
  earlier Web `/design` run, not by this converter test.

## Reproduce local checks

```sh
bun test src/commands/design/index.test.ts src/commands/design-sync/index.test.ts src/skills/bundledSkills.test.ts src/skills/bundled/updateConfig.test.ts src/tools/DesignSyncTool src/tools/ClaudeDesignTool src/services/design
node scripts/extract-claude-code-221-design-sync.mjs /path/to/audited/claude --check
node scripts/test-design-sync-converter.mjs /path/to/converter/node_modules
```

The converter test's separate dependency directory used esbuild 0.27.7,
ts-morph 26.0.0, react/react-dom 19.2.4, and @types/react 19.2.14. Product
dependencies and the product lockfile were not changed. The test creates its
own temporary workspace and does not touch remote projects.

## Still required before live PASS

After an explicit coordination CLEAR: build from the new clean committed source,
verify complete immutable image identity, import sequentially to all three
nodes, and roll out through the owning runtime task. Then invoke `/design-sync`
in authenticated Web Code through IAB on a disposable React fixture, approve
only the scoped test writes, inspect uploaded components in Design, and repeat
after a source edit. Observe the model's final response as well as the rendered
artifact. A new runtime has not passed those steps yet.

The local structural validator explicitly used `--no-render-check`; its skipped
Playwright validation must not be reported as passed. IAB verified the package
card and three generated Storybook stories separately. A full Storybook build,
reference visual grading, authenticated upload/re-sync, and all other pending
parity journeys remain unverified here.
