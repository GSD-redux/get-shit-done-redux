---
type: Fixed
pr: 3114
---
**A split-parent phase marked complete in the ROADMAP is no longer permanently reported as `current_phase`** — a phase split into sub-phases (parent kept as shared context, zero plans by design) was stuck as `researched` because the roadmap-checkbox override required `completion.phase_complete` (always false for zero-plan phases). The override now fires for zero-plan phases when the roadmap checkbox is checked. (#3033)
