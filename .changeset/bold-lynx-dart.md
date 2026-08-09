---
type: Fixed
pr: 0
---
**The execute-phase workflow no longer tells agents that Claude Code's `Agent()` dispatch blocks until the subagent finishes** — Claude Code backgrounds subagents by default, so an orchestrator trusting the old text could treat a wave as returned when it had not. The dispatch note and the completion-signal fallback now match this package's own shipped capability matrix. (#3177)
