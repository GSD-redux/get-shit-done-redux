---
type: Fixed
pr: 2814
---
**`broken-windows` capability no longer claims ship blocking is unconditional** — the description now states that `/gsd-ship` blocking applies only when `workflow.windows_enforce` is enabled (default `false`); ledger tracking is unaffected. (#2787)
