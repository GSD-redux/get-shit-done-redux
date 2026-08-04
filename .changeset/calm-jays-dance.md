---
type: Added
pr: 0
---
**Agent-dispatch isolation guard.** An executor subagent dispatch that would run outside an isolated worktree is now hard-blocked when the project resolves to harness-worktree, closing the #260-class main-checkout write path a prose-only instruction could silently skip. Covers both Claude Code (a missing `isolation="worktree"` parameter on the `Agent()` dispatch) and Cursor (a `subagentStart` dispatch whose session is not actually running in an isolated Cursor worktree, verified structurally since Cursor's `--worktree` is a session-level flag with no per-dispatch isolation parameter to check). (#3045)
