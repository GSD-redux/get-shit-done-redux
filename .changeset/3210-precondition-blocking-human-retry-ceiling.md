---
type: Fixed
pr: 3528
---

**Autonomous/auto-mode no longer auto-approves unmet `<precondition>` checkpoints, and the blocker loop now halts `needs_human` instead of retrying forever** — the checkpoint an executor returns when a task's `<precondition>` is unmet (an unmet `user_setup` step, a missing env var, an absent prior-phase artifact) now carries `gate="blocking-human"`, which both auto-mode bypass layers (executor checkpoint protocol and execute-phase checkpoint handling) honor, so it always stops for a human instead of being silently approved with a synthetic "approved" and then failing `<verify>` on the still-missing prerequisite. Independently, `/gsd:autonomous`'s blocker handler now counts "Fix and retry" attempts per phase step and, after 3 failed attempts, escalates to a terminal `needs_human` halt that surfaces the unmet items and records a `## Needs Human` STATE.md row, ending the observed multi-hour retry loops on operator-gated plans. (#3210)
