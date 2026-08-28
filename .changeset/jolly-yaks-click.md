---
type: Fixed
pr: 4006
---
**Interrupted executors can be resumed again** — execute-plan deleted `current-agent-id.txt` before the check that read it, so the interrupted-agent detection and its Task `resume` prompt were unreachable after a kill; the id is now captured before the stale marker is cleared. (#3795)
