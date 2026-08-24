---
type: Fixed
pr: 3681
---
**Bounded prohibition checks no longer orphan the worker a hung check leaves behind on POSIX** — a `node --test` runner that hit its timeout used to be killed while the per-file worker actually executing the subject was never signalled at all, so it survived reparented to PID 1 and burned a core indefinitely while the suite stayed green; a bounded check now reaps its whole process group whenever the child did not exit on its own, on interrupt as well as on timeout. Windows is not yet covered and is tracked as follow-up work on the same issue.
