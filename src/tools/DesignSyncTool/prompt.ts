export const DESIGN_SYNC_PROMPT = `Sync a local design-system implementation with Claude Design.

Read methods: list_projects, get_project, list_files, get_file.
Setup: create_project. Before any mutation, call finalize_plan with the exact projectId plus every write/delete path and the localDir containing disk-backed files. Then use the returned planId for write_files, delete_files, register_assets, or unregister_assets.

Prefer localPath over inline data for files already on disk. The tool reads disk-backed files directly, preserves UTF-8 text, base64-encodes binary content, and never exposes their bytes to the model context. CLAUDE.md and .claude paths are always reserved. Use report_validate only for the aggregate final render-check counts.`
