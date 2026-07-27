---
type: Fixed
pr: 2728
---
/gsd:quick and the UAT-diagnosis step no longer abort with a FATAL on non-Claude runtimes. Both dispatch sites now resolve worktree isolation through the negotiated dispatch.isolation capability (#2584) instead of a hardcoded RUNTIME != "claude" test, so a runtime is judged by what it declares rather than by its name.
