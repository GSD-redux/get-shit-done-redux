---
type: Changed
pr: 4366
---
**Context-monitor WARNING/CRITICAL fire-points are now readable from `.planning/config.json`** — `hooks.context_warning_threshold` (default 35) and `hooks.context_critical_threshold` (default 25) move the two rungs per project, so a tuned fire-point survives an update instead of being re-staged away with the managed hook file. Absent keys resolve to today's 35/25, so existing projects are unchanged. An unusable value falls back per key; both revert to their defaults only when the resolved pair violates `critical < warning`. The keys are root-project settings — the hook reads `<cwd>/.planning/config.json` only. (#4285)
