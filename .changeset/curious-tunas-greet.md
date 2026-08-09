---
type: Changed
pr: 0
---
**Worktree-wave merges now warn when a plan branch committed outside its declared scope** — the `execute-phase` cleanup gauntlet compares each branch's actual committed diff against the `files_modified` the plan declared and reports every path outside it. Advisory only: the merge still proceeds and the exit status is unchanged. (#2596)
