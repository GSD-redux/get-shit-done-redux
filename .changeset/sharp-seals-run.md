---
type: Fixed
pr: 0
---
**The stale-worktree health check no longer flags the worktree you are currently in on Windows** — paths that differ only by drive-letter or folder casing (as-typed vs git's canonical spelling) are now recognized as the same directory on Windows, while case-sensitive comparison is preserved on macOS/Linux. (#3663)
