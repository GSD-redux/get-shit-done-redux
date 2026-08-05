---
type: Fixed
pr: 3070
---
**Completing the last phase of a milestone no longer advances into a 0.x backlog sentinel row** — the phase-completion cascade's lowest-outstanding-phase override had no sentinel filter, so an unchecked backlog row like Phase 0.1 sorted below every real phase and was selected as the next phase, corrupting STATE.md and desyncing the current phase number from its name. The override now excludes sentinel-range phase ids via the existing isSentinelPhaseId predicate, so a real lower-numbered outstanding phase is still selected while backlog sentinels are skipped and the milestone completes cleanly.
