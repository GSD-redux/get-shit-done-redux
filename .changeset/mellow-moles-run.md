---
type: Added
pr: 4147
---
**`/gsd:plan-phase` now warns when RESEARCH.md/PATTERNS.md predate CONTEXT.md's newest decisions** — a new deterministic pre-check compares each artifact's git commit time against CONTEXT.md's before plan-phase silently reuses it; opt into blocking with `workflow.context_drift_action: block`. (#3348)
