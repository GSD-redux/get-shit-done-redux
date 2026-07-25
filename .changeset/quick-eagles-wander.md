---
type: Fixed
pr: 2634
---
**`/gsd-plan-phase` no longer 404s on non-Claude runtimes with `model_profile:"inherit"` + `resolve_model_ids:"omit"`** — the workflow passed `model="{planner_model}"` (and researcher_model/checker_model) verbatim into Agent() calls, so when the resolved model was empty it sent `model=""` and the runtime fell back to an unavailable Claude model → 404. plan-phase now mirrors execute-phase: when a `*_model` is "inherit" or empty, the `model=` param is omitted so the subagent inherits the orchestrator model. (#2517)
