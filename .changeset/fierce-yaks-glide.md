---
type: Fixed
pr: 4289
---
**`/gsd:progress --do` now routes specific commands before generic keywords, confirms the route before dispatch, and forwards only arguments the target command accepts** — freeform requests like "set up this existing codebase" or "wrap up the spike findings" no longer preempt to the wrong lifecycle command, and no command runs without your confirmation. (#4051)
