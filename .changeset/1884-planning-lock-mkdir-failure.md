---
type: Fixed
pr: 3472
---

**`withPlanningLock` no longer reports a phantom "held by a live process" timeout when `.planning/` cannot be created** — a best-effort `try { platformEnsureDir(...) } catch { /* ok */ }` swallowed the real mkdir failure (EACCES/ENOSPC/EROFS), so the subsequent lock write failed with ENOENT (parent missing), and because ENOENT is in the lock's retry set (added for a Docker overlay-fs race) the loop spun the full 10 s budget before throwing a misattributed contention error that pointed operators at a nonexistent lock-holder. The mkdir failure now propagates immediately with its real filesystem errno and message, so an unwritable or full disk is reported as itself, not as concurrent-writer contention. The Docker overlay-fs ENOENT *lock-write* race (directory present) is still retried as before, and every code path where `.planning/` already exists or can be created is unchanged. Part of epic #1879 (distinguish "absent" from "corrupt/permission-denied" across engine read paths). (#1884)
