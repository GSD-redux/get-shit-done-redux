---
type: Fixed
pr: 3138
---
**Spec-phase edge resolution vocabulary realigned to the code's `Status` enum** — the workflow prose in spec-phase.md, plan-phase.md, and ui-phase.md used the retired `covered`/`backstop`-as-status vocabulary that `validateResolution` rejects. Now uses `resolved` + `verification: explicit|backstop`. (#3132)
