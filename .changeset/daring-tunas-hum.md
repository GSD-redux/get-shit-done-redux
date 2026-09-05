---
type: Added
pr: 4277
---
**New `phase.tdd-applicable` query verb** — computes whether the TDD RED/GREEN/REFACTOR procedure applies to a given plan (explicit flag, plan `type: tdd` frontmatter, a task's `tdd="true"` attribute, or the `workflow.tdd_mode` config default), in one place. Also fixes `workflow.tdd_mode`, `workflow.research`, and `workflow.nyquist_validation` config keys, which never actually reached `cmdInitExecutePhase`/`cmdInitPlanPhase`/`cmdInitDebug`/`cmdInitNewMilestone` due to a dead `config.workflow` accessor. (#4273)
