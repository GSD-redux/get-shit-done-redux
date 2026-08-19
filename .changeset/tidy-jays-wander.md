---
type: Fixed
pr: 3681
---
**Bounded prohibition checks no longer orphan a busy-spinning worker when a check hangs** — every bounded spawn is now a process-group leader and the whole group is unconditionally reaped, so a timed-out `node --test` runner cannot leave its per-file worker burning a core (POSIX; Windows behavior unchanged).
