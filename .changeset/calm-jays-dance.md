---
type: Added
pr: 3069
---
**Agent-dispatch isolation guard.** An executor subagent dispatch that would run outside an isolated worktree is now hard-blocked when this dispatch's resolved isolation is harness-worktree, closing the #260-class main-checkout write path a prose-only instruction could silently skip — while correctly leaving legitimate sequential or orchestrator-managed dispatches (project opt-out, submodule intersection, diverged-base auto-degrade) untouched, since the guard reads the workflow's own resolved per-dispatch decision instead of a host's general capability. Covers a missing `isolation="worktree"` parameter on the `Agent()`/`Task()` dispatch, as well as a `subagentStart` dispatch whose session is not actually running in an isolated worktree, verified structurally since a session-level worktree flag carries no per-dispatch isolation parameter to check. (#3045)
