---
type: Changed
pr: 0
---
**`state.*` commands now report every field they actually changed, and only those** — the `updated` array is derived by diffing what was persisted against the pre-write state, so a counter the write genuinely moved is no longer suppressed, a field the write merely preserved is no longer claimed as an update, and a changed sub-counter is named at leaf granularity (`progress.total_plans`) instead of being dropped. Callers that compared the array exactly will see more, and truer, entries. (#3872)
