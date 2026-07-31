---
type: Fixed
pr: 2892
---
**State sync now reports the correct total phase count on a flat unmilestoned roadmap** — `progress.total_phases` no longer falls back to the on-disk phase-directory count when the roadmap has no versioned milestone heading; it uses the authoritative roadmap count, matching the write-path and resolving the contradiction between smart-entry's `total_phases` and `roadmap_total_phases`. (#2828)
