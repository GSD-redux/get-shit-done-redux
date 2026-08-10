---
type: Changed
pr: 0
---
**`init` now reports the host runtime it is actually running under** — inside a Codex session GSD reported `agent_runtime: claude`, and checked the wrong directory for installed agents, because runtime identity was only ever read from `GSD_RUNTIME` or an explicit `runtime` in `.planning/config.json`. A detection rung now sits beneath both explicit sources, resolving `codex` from Codex's own session environment. Explicit settings still win, no shared defaults are written, and model resolution is untouched. (#3245)
