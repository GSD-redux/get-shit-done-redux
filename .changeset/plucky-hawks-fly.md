---
type: Fixed
pr: 3106
---
**A worktree whose owner could not be probed is no longer deleted** — an orphan lock holding a process id above 2147483647 made the liveness check throw a type error rather than an errno error, which read as "owner is dead" and removed the worktree. Only "no such process" now means dead; every unrecognized outcome leaves the worktree alone. An unreadable lock timestamp also reported "too fresh", advising a wait that could never help, and now reports its own reason. (#3103)
