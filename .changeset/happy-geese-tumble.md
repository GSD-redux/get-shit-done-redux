---
type: Fixed
pr: 2680
---
**Cursor CLI sessions now detect `.planning/`** — the `sessionStart` and `stop` hooks resolved the project from `process.cwd()`, which under the `cursor-agent` CLI is the Cursor config dir (`~/.cursor`), not the workspace. Every CLI session therefore reported "no .planning/ workflow found" even with `.planning/STATE.md` present, and the stop hook's verify-work reminder could never fire. Both hooks now read `workspace_roots` from the hook payload they already buffered but never parsed, preferring the root that actually carries `.planning/STATE.md` (multi-root workspaces) and falling back to the first root, then `cwd` so IDE invocations are unchanged. (#2587)
