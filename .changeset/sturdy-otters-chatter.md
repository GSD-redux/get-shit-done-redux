---
type: Fixed
pr: 0
---
**`workflow.use_worktrees=false` now actually wins for executor dispatch** — `query dispatch-isolation` folds the project opt-out into the isolation sentinel it records, so a plain re-query can no longer re-persist the host's worktree capability over the mandated `none` record and have the isolation guard deny the sequential dispatch the project configured. (#3737)
