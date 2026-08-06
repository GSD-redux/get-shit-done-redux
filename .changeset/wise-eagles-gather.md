---
type: Fixed
pr: 3109
---
**Workflow-backend worktree branches (`worktree-wf_*`) are now recognized by all worktree guards** — the Claude-orchestration Workflow backend created worktrees on branches none of the four guards recognized, causing the path-containment hook to fail open and the cleanup/executor commands to reject or silently drop entries. All four sites now accept the `worktree-wf_` namespace alongside `agent-*` / `worktree-agent-*`. (#3021)
