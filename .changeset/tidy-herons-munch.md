---
type: Changed
pr: 2987
---
**`/gsd-execute-phase` now loads only the branch guidance your invocation actually uses.** Running it without `--wave` no longer pulls the wave-filtering instructions into context, and a plain integer phase no longer loads the decimal-phase gap-closure branch. The init bundle reports which sections apply to each invocation and the workflow reads only those, so the orchestrator spends its context on the path it is actually taking. (#2932)
