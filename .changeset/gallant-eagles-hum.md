---
type: Fixed
pr: 3088
---
Several guards that could not verify something previously reported the same result as everything is fine: a duplicate external job could dispatch past a corrupt sibling manifest, `state rebuild` could report success while phase-table reconciliation never ran, an unreadable lock body was treated as freely stealable at the same short window as a genuinely empty one, a staleness check that itself failed reported not stale, and `git base-branch` returned `main` whether it verified that or every git query timed out. These now fail closed instead of silently succeeding. (#3057)
