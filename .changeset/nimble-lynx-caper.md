---
type: Fixed
pr: 0
---
**The milestone audit report is written where its readers look for it** — `/gsd-audit-milestone` created the report at a doubled `.planning/v{version}-v{version}-MILESTONE-AUDIT.md` path while every downstream reference (Report pointers, the `cat`, the completion checklist) reads the single-version `v{version}-MILESTONE-AUDIT.md`, so the report silently landed unread. (#3796)
