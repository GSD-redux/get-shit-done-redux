---
type: Fixed
pr: 3892
---
**Codex `orchestrator-worktree` waves now honour an explicit `gsd-executor` model pin** — an explicit `model_overrides.gsd-executor` value resolved correctly but never reached the spawned `codex exec` argv, so wave-parallel executors silently ran the global Codex session model. Unpinned setups are unchanged: a blank, `inherit`, tier-alias, or absent override still inherits the session model.
