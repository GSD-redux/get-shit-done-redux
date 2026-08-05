---
type: Added
pr: 0
---
**Agent-dispatch isolation guard.** An executor subagent dispatch that would run outside an isolated worktree is now hard-blocked when this dispatch's resolved isolation is harness-worktree, closing the #260-class main-checkout write path a prose-only instruction could silently skip — while correctly leaving legitimate sequential or orchestrator-managed dispatches (project opt-out, submodule intersection, diverged-base auto-degrade) untouched, since the guard reads the workflow's own resolved per-dispatch decision instead of a host's general capability. Covers both Claude Code (a missing `isolation="worktree"` parameter on the `Agent()`/`Task()` dispatch) and Cursor (a `subagentStart` dispatch whose session is not actually running in an isolated Cursor worktree, verified structurally since Cursor's `--worktree` is a session-level flag with no per-dispatch isolation parameter to check). (#3045)
