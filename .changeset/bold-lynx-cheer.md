---
type: Fixed
pr: 0
---
**`/gsd-ingest-docs`, `/gsd-import`, `/gsd-audit-fix`, `/gsd-diagnose-issues`, and `/gsd-profile` now honor model routing for their subagents** — the doc classifier/synthesizer, roadmapper, plan-checker, fix executor, debugger, and user-profiler subagents ran on the calling session's model, silently ignoring `dynamic_routing`/`model_profile` tier config. Each workflow now resolves the per-agent model and passes it on the spawn (omitting it when it resolves to inherit/empty per #2517). (#3602)
