---
type: Fixed
pr: 4110
---
**Progress routing preserves decimal phase IDs** — `init progress` now orders parent and inserted phases canonically, and `smart-entry --json` returns the complete current phase token instead of truncating it to an integer.
