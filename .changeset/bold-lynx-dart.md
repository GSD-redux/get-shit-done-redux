---
type: Fixed
pr: 0
---
**Two GSD workflows told agents that a Claude Code `Agent()` spawn blocks until the subagent finishes** — Claude Code backgrounds subagents by default, so `/gsd-execute-phase` could treat a wave as returned when it had not, and `/gsd-debug` lost its session-manager handoff in exactly the way #2196 was filed to fix. The dispatch notes now match this package's own shipped capability matrix, and the debug spawn carries the `run_in_background: false` opt-out it always needed. (#3177)
