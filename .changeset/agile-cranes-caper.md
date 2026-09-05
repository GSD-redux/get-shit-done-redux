---
type: Fixed
pr: 4299
---
**Background waits no longer emit a red ScheduleWakeup validation error** — while a background subagent (researcher/planner/checker or the manager dashboard's dispatch) was in flight, the orchestrator could literalize "I'll wait" by calling the host's ScheduleWakeup tool with partial arguments, surfacing "`prompt` is required when `stop` is not true."; every GSD wait-instruction site now explicitly forbids wake-up scheduling. (#4079)
