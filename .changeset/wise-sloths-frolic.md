---
type: Fixed
pr: 0
---
**`worktree cleanup-wave` no longer treats a safe deletion as an unconditional merge blocker, and no longer aborts the rest of the wave when one entry is blocked** — a deletion is now only blocked when another wave member's branch still depends on the deleted file, and every other independently-clean entry in the wave still merges and is removed even when one entry is blocked. (#2852)
