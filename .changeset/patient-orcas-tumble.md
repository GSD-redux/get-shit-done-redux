---
type: Fixed
pr: 4322
---
**STATE.md progress counters are no longer silently regressed on projects whose asserted milestone has no matching ROADMAP heading** — under the milestone-unbounded (or ROADMAP-absent) condition, every resyncing `state.*` write kept `progress.total_phases` at its stored value but clobbered `completed_phases`, `total_plans`, and `completed_plans` with the under-scoped phase-directory scan; all four counters are now withheld together and keep their stored values. (#4094)
