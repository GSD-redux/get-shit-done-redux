---
type: Fixed
pr: 3281
---
**Two GSD workflows told agents that a Claude Code `Agent()` spawn blocks until the subagent finishes** — Claude Code backgrounds subagents by default, so `/gsd-execute-phase` could treat a wave as returned when it had not, and `/gsd-debug` lost its session-manager handoff in exactly the way #2196 was filed to fix. The dispatch notes now match this package's own shipped capability matrix, and both debug spawns carry the `run_in_background: false` opt-out they always needed. (#3177)
