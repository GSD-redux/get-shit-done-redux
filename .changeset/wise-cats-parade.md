---
type: Fixed
pr: 4390
---
**An executor that finished its plan is no longer reported as failed when its session ends abnormally** — execute-phase now reconciles the plan SUMMARY and matching commits before classifying any plan as failed, on every runtime and however the child ended (interrupted, closed, timed out, `turn_aborted`), and never re-dispatches work that is already committed. (#4217)
