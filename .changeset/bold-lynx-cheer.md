---
type: Fixed
pr: 0
---
**`/gsd-ingest-docs`, `/gsd-import`, `/gsd-audit-fix`, `/gsd-profile-user`, and `/gsd-docs-update` now honor model routing for their subagents** — the doc classifier/synthesizer/verifier, roadmapper, plan-checker, fix executor, and user-profiler subagents (plus the debugger spawned by the `diagnose-issues` workflow behind `/gsd-verify-work`) ran on the calling session's model, silently ignoring `dynamic_routing`/`model_profile` tier config. Each workflow now resolves the per-agent model and passes it on the spawn (omitting it when it resolves to inherit/empty per #2517). (#3602)
