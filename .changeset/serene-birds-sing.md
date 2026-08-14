---
type: Fixed
pr: 3490
---
state planned-phase now refreshes the Current Position Phase: line (the body source current_phase is re-derived from) instead of leaving a stale previous-phase line behind, so STATE.md frontmatter, body prose, and state json stay coherent; the --name argument is persisted into the Phase line and current_phase_name instead of being silently dropped.
