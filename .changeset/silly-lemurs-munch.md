---
type: Fixed
pr: 4442
---
**`/gsd-execute-phase` no longer closes a finished executor as `turn_aborted`** — an executor whose plan SUMMARY and matching commits are already on disk is now reconciled as complete when its session ends abnormally, instead of waiting indefinitely for a terminal response and failing. (#4217)
