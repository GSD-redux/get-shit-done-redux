---
type: Fixed
pr: 4194
---
**`/gsd-execute-phase` crash-recovery gate now lists the crashed plan's own commits** — the safe-resume gate grepped a padded, unanchored plan scope, citing other milestones' commits and never the plan's own; all three commit-scope greps are now anchored, zero-pad-tolerant, and bounded to the current milestone tag. (#4003)
