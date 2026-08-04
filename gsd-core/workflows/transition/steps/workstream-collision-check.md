**Workstream collision check (when `is_last_phase: true`):**

Before routing to Route B, check whether other workstreams are still active.
This prevents one workstream from advancing or completing the milestone while
other workstreams are still working on their phases.

**Skip this check if NOT in workstream mode** (i.e., `GSD_WORKSTREAM` is not set / flat mode).
In flat mode, go directly to **Route B**.

Parse `other_active_workstreams` from `INIT_TRANSITION` (already fetched above — no
`gsd_run` call needed here). `init.transition` pre-filters this list exactly as this
check requires: it excludes the current workstream (`$GSD_WORKSTREAM`) and any
workstream whose status contains "milestone complete" or "archived"
(case-insensitive). Each remaining entry has `name` and `status`.

- **If `other_active_workstreams` is non-empty** → Go to **Route B1**
- **If `other_active_workstreams` is empty** (or flat mode) → Go to **Route B**
