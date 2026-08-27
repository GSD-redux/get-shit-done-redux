---
type: Fixed
pr: 0
---
**`total_plans` no longer counts REPLAN/PLANNING documents as plans** — a phase directory carrying a `REPLAN-INPUTS` or `PLANNING-NOTES` document no longer inflates the plan count that STATE.md derives on every state-mutating call. (#3741)
