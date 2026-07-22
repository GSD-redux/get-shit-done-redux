---
type: Fixed
pr: 2531
---
`/gsd:settings` no longer recommends or persists `workflow.use_worktrees: true` on non-Claude runtimes (where execution fails closed on it); it offers disabling or leaving the key untouched and warns about an inherited explicit `true`. `/gsd:health` reports such a config as new warning W020 before execution-time failure. (#2486)
