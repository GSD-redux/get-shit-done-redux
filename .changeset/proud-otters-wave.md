---
type: Changed
pr: 3030
---
**Workflow guidance now loads only the branch your invocation actually took** — thirteen more large workflows moved onto the fragment model, so running `/gsd-code-review` without `--fix` no longer loads the fix-dispatch branch, `/gsd-progress` without `--forensic` no longer loads the forensic audit, and so on across every migrated workflow. (#2994)
