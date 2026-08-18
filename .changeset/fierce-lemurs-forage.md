---
type: Fixed
pr: 0
---
**Completing one phase no longer marks the whole milestone done** — `state complete-phase` wrote the body prose `Phase N complete`, and the status normalizer matches `complete` as a substring, so finishing phase 2 of 4 collapsed the milestone-level STATE.md frontmatter to `status: completed` while the very same call correctly recorded `completed_phases: 2` of `total_phases: 4`. Downstream automation that gates on milestone status — auto-advance, archival, ship gating — was told a half-open milestone was finished. Milestone status is now derived from those counters instead of from phase-level prose. (#3578)
