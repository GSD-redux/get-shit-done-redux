---
type: Fixed
pr: 3681
---
**Bounded prohibition checks no longer orphan the worker a hung check leaves behind** — a `node --test` runner that hits its timeout used to be killed while the per-file worker actually executing the subject was never signalled at all, so it survived reparented to PID 1 and burned a core indefinitely while the suite stayed green; every bounded check now reaps its whole subtree when the call ends, on POSIX and Windows alike, and on interrupt as well as on timeout.
