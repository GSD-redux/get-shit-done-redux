---
type: Fixed
pr: 2955
---
**/gsd-verify-work diagnosis and interactive plan execution no longer halt on a stale worktree fork base** — when worktrees are enabled and local HEAD has advanced past `origin/HEAD` (the GSD steady state of committing every step and pushing only on request), the spawned debug/executor agent used to fork from the stale ref and hit a base-mismatch fatal mid-investigation with no recovery. Both dispatch sites now run the same pre-dispatch `worktree.base-check` gate the executor and quick-task paths already run, auto-degrading to sequential main-tree dispatch with an explanatory message. (#2649)
