---
type: Fixed
pr: 3575
---
**Recorded why install materialization stays three loops, not one** — an architecture decision for epic #2866 phase 6. Measuring the three sites showed they diverge in mechanism rather than duplicate each other, so unifying them would have broken a prune that structurally cannot delete user files. (#3574)
