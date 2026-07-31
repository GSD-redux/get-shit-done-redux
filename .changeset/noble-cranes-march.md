---
type: Fixed
pr: 2902
---
**A requirement row stranded at `Gaps Found` can now be completed again, and `requirements mark-complete` no longer reports false success on a row it could not move** — the completion guards now accept `Gaps Found` (so `revert-phase`'s stranded rows are recoverable instead of permanently blocking the milestone), and when a traceability table has a row for an ID, `mark-complete` counts it as updated only if the row actually moved (not merely because the checkbox flipped). (#2788)
