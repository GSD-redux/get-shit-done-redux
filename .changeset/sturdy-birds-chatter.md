---
type: Fixed
pr: 2531
---
**Settings no longer offer Claude-only worktree isolation on non-Claude runtimes** — previously `/gsd:settings` recommended "Yes" and persisted `workflow.use_worktrees: true` on every runtime, handing non-Claude installs the exact value `/gsd:execute-phase` and `/gsd:quick` fail closed on. Non-Claude runtimes now get "No (Recommended)" / "Leave unchanged" with a warning when the config carries an inherited explicit `true`, and `/gsd:health` surfaces such a config as new warning W024 before execution-time failure. (#2486)
