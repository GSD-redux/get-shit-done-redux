---
type: Fixed
pr: 2727
---
**Refusing to run a phase from an executor worktree now tells you how to recover your work** — when GSD stopped because the session had drifted into an executor worktree, it only said to re-run from the orchestrator's worktree. If that worktree held commits or uncommitted changes, following that advice silently abandoned them. The refusal now lists the commits and files that exist only there, and gives the exact steps to integrate them before continuing. (#1856)
