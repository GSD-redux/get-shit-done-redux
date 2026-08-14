---
type: Fixed
pr: 0
---
Workflow-backend waves (claude-orchestration, BETA) no longer strand executor commits on worktree-wf_* branches: the emitted Workflow script now returns each agent's worktree metadata, and the orchestrator records it into the wave manifest so the existing merge-and-cleanup step lands every plan's commits. Missing metadata now halts the wave loudly instead of reporting success with an empty worklist.
