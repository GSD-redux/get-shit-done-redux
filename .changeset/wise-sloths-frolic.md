---
type: Fixed
pr: 3009
---
**`worktree cleanup-wave` no longer aborts the rest of a wave when one entry is blocked** — a blocked entry (mismatched branch/base, a deletion, a dirty worktree, or a failed merge/removal) now stays blocked with its existing reason code, while every other independently-clean entry in the wave still merges and is removed instead of being stranded unattempted. (#2852)
