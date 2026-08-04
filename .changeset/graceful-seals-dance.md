---
type: Fixed
pr: 2728
---
**`/gsd-quick` and the UAT-diagnosis step no longer abort with a FATAL on non-Claude runtimes** — both dispatch sites resolved worktree isolation from a hardcoded `RUNTIME != "claude"` test, so every non-Claude host was refused regardless of what it could actually do. They now read the negotiated `dispatch.isolation` capability (#2584), and installs for runtimes that declare worktree support no longer stamp `workflow.use_worktrees` to `false`, which had pre-empted that negotiation. A runtime is judged by what it declares rather than by its name.
