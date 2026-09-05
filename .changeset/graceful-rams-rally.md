---
type: Fixed
pr: 4292
---
**`state advance-plan` no longer marks a phase complete while sibling plans are still executing** — a stale or wave-raced `Plan: X of Y` counter could write `Phase complete — ready for verification` after 1 of N plans; the decision now comes from disk (every plan summarized) and the call declines with `plans_outstanding` instead. (#4067)
