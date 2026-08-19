# Claude Design 2.1.221 provenance

This implementation is a source-faithful port of the Design surfaces embedded
in the official Claude Code `2.1.221` Darwin arm64 executable. It is not an
inference proxy and does not reconstruct a Design protocol from the web app.

## Audited artifact

- Artifact: `/Users/begiyan/Desktop/code/downloaded_builds/helpers/claude-code/2.1.221/darwin-arm64/claude`
- `--version`: `2.1.221`
- SHA-256: `7a181f36ed0fc4fbac6cee4ecf2b615eff93d8b434221fff5d7c878dc5ebf380`
- Release manifest source commit: `6efaf12e8b43dc7dbe50e0955c76dc4174a15876`

Offsets below are decimal file offsets from `strings -a -t d` or the adjacent
decoded Bun string/code region in that exact executable. A value is ported only
when its literal, branch, or wire shape is present there.

## Gate, OAuth, and control plane

| Contract | 2.1.221 evidence |
| --- | --- |
| Managed-policy gate `allow_design_sync`, nonessential-traffic gate, first-party provider/base gate, and GrowthBook `tengu_omelette_fouet` | service/type/flag strings `70358384..70358752`; sync client `109705280`; policy key `109805200` and `109919552`; decoded adjacent gate branches |
| Read/write scopes | OAuth/Design auth region `109795360..110023696`: `user:design:read`, `user:design:write` |
| Production Design OAuth client ID `59637612-477b-4836-a601-b0589eda7704`; local/staging zero placeholder | OAuth configuration region `238351681..238353100` |
| Separate secure Design OAuth slot, PKCE/manual callback, primary-token precedence, refresh, and five-minute refresh skew | decoded auth region `248308000..248320089`; refresh helper near `241265544` |
| Consent bit `agent_design_projects`; explicit consent/revoke commands | `109807200`, `212260880..212269264` |
| `/design-login` and exact description | name `212278288`; description `134042016` and `212278288` |

The Darbmind host-managed external-inference exception is deliberately narrow:
the OAuth/control origin must still be an allowlisted first-party Darbmind
origin, while the model base URL is supplied by the host. It does not relax the
Design OAuth destination or accept an arbitrary third-party control plane.

## `DesignSync`

| Contract | 2.1.221 evidence |
| --- | --- |
| Direct RPC service and methods `ListOrgProjects`, `GetProject`, `ListFiles`, `GetFile`, `WriteFiles`, `DeleteFiles`, `RecordAsset`, `DeleteAsset`, `CreateProject` | service/type strings `70358384..70358448`; decoded direct-RPC client/tool region `248302000..248342727` |
| POST `/<anthropic.omelette.api.v1alpha.OmeletteService>/<Method>`, camel-case JSON, bearer auth, `X-Anthropic-Client: claude-cli-design-sync` | same direct-RPC region `248302000..248342727` |
| 60-second timeout and 32 MiB bounded response | same direct-RPC request helper region |
| Project type `PROJECT_TYPE_DESIGN_SYSTEM` | direct-RPC list/create region |
| Operations `list_projects`, `get_project`, `list_files`, `get_file`, `finalize_plan`, `write_files`, `delete_files`, `register_assets`, `unregister_assets`, `create_project`, `report_validate` | DesignSync schema/tool region `248317000..248342727` |
| Plan IDs `plan_<normalized-project-prefix-1..16>_<12-hex>` and process-local plan registry | decoded plan helper in the same DesignSync region |
| UTF-8 project path cap 256 bytes | literal/helper `IBt=256` near `244272243` |
| Batch cap 256, at most three wildcard tokens, local file cap 12 MiB | DesignSync schemas and local materializer region `248317000..248342727` |
| Local realpath containment and `O_NOFOLLOW`; text/base64 split | DesignSync local-file materializer region |
| Reserved `CLAUDE.md` and `.claude` paths | DesignSync write/delete validation region |
| `/design-sync` is user-only, argument hint `[<project hint, e.g. "Acme DS">]`, and exact menu description | `257704006..257705728`; command strings `147393472..147393584` |
| Noninteractive Web handoff says the web flow “seeds the project into the workspace” | auth failure string `109874224` |

## `ClaudeDesign`

| Contract | 2.1.221 evidence |
| --- | --- |
| MCP endpoint `/v1/design/mcp`, protocol `2025-03-26`, initialize client `claude-cli-design-tool` version `1`, then `tools/list` and `tools/call` | protocol/client strings `110000448..110000480`; decoded native tool/client region `248342851..248368425`; request helper around `248361000` |
| Headers `Authorization`, `anthropic-version: 2023-06-01`, `X-Anthropic-Client`, JSON plus event-stream Accept, and MCP session header | same request helper |
| 60-second timeout, reject event-stream, reinitialize once on 404, refresh once on 401 | strings `109990480`, `110000624`, `110009776`, `110018832`; adjacent request branches |
| Response content cap `16 * 130000` and aggregate projection cap `130000` | literal `_Xs=130000` near `248364170` and adjacent bounded reader |
| Catalog cache cap 64 and refresh wait 5000 ms | decoded discovery/catalog region |
| Read operations: design systems/prompt/projects/files/conversations/members | native schema catalog region |
| Write operations: preview/project/conversation/plan/files/copy/delete/support.js/members/sharing | native schema catalog region |
| Unknown discovered read-only operations allowed; unknown write-capable operations fail closed | native catalog validation branches |
| Path-scoped plan approval capped at 15 minutes; durable project grant; tokenless copy fails closed; destructive operations are gated | native permission/control region `248350000..248368425` |
| Durable-grant approval renders only a server-verified project name, sharing scope, and canonical project URL; instruction-bearing or unenumerable writes stay on the per-batch plan path | identity verifier and write-target branches in `248350000..248375306` |
| Consent/grant 403 mapping and explicit server-side consent/grant writes | native MCP permission wrapper and strings `109807200`, `212260880..212269264` |
| Permission ask metadata `localDisplayOnly`; generic server-approval observer registry; initial poll then 3-second exponential backoff (×1.5, capped at 15 seconds); plan-mode parking; observed-grant marker | registry `247703501`; permission runner `247703858`; local-only branch `247704073`; watcher branch `247706471..247706900`; Design descriptor `248375306`; Design observer registration `248385785` |

## `/design` hub

The built-in prompt is byte-copied semantically from strings
`147378944..147382384`. It first calls `ClaudeDesign({operation:"list"})`, then
routes free-form briefs through `get_claude_design_prompt`; `import` through
`get_project`/`list_files`/`read_file`; `export` through
`create_project`/`finalize_plan`/`write_files`; and `status` through
`list_design_systems`/`list_projects`. Names, aliases, and argument hint are at
`147384000..147384336`; the exact menu description is at
`147385760..147386080`.

This port intentionally contains no Claude Code lifecycle, Remote Code,
Cowork, Schedule, web-app inference, or minified frontend behavior.
