---
type: Changed
pr: 4124
---
**The codebase drift check now reports real drift** instead of flagging every file in the repository on every run. Mapping a codebase records the point it was mapped at, so the check compares against that point, and it skips with a reason when no such record exists.
