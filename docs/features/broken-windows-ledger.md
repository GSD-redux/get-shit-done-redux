---
id: 158
title: Broken-Windows Ledger
group: v1.7.0 Features
---

**Behavior:** A cross-phase defect register at `.planning/WINDOWS.md` accumulates stubs, TODOs, skipped tests, unrun verifies, and unmet truths (#1950). `/gsd-ship` blocks while any entry is `open`; an entry can be `waived` only with a recorded reason (auditable) or marked `fixed` (removed from the blocking set). `/gsd-progress` surfaces the open + waived counts.

**Commands:** `gsd-tools windows status | append | waive | fixed`.

**Config:** `workflow.windows_enforce` (gate active, default `false` — opt-in enforcement). Enable with `gsd config-set workflow.windows_enforce true`. Tracking (the ledger itself, populated by the executor) is always on; only the ship gate is opt-in.

**Backward compatibility:** A project with no `.planning/WINDOWS.md` reports `open_count: 0` and ships cleanly; the gate only activates once windows are recorded.

**Configuration:** `graphify.graph_path`
