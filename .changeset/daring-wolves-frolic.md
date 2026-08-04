---
type: Fixed
pr: 3038
---
**A halted plan no longer leaves its dependents on the runnable work list** — when a plan reaches a designed stop and its SUMMARY records `status: halted`, plans that depend on it (directly or transitively) are now reported as blocked, with the halted plan(s) named, instead of being offered to the executor as ordinary incomplete work. (#2830)
