---
type: Fixed
pr: 4318
---
**`state advance-plan` no longer strands you when `## Current Position` has lost its labeled plan-position lines** — the failure now returns reason `plan_position_unreadable` with the phase directory's on-disk plan/summary counts and the exact labeled lines to re-insert, instead of a bare unparseable error with no recovery path. (#4093)
