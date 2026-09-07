---
type: Fixed
pr: 4391
---
**A working executor is no longer interrupted or told to "Finalize immediately"** — execute-phase's stall threshold now measures time without progress rather than total runtime, an executor with commits and recent activity is left alone until its SUMMARY lands, and a missing local test/build process no longer counts as idleness. (#4218)
