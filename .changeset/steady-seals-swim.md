---
type: Fixed
pr: 2974
---
**`phase remove` now reports accurate state_updated and keeps STATE.md progress counters in sync** — the command reported `state_updated: true` based on file existence (always true) rather than actual content change, and the frontmatter `progress.total_phases`/`completed_phases`/`percent` counters went stale when the STATE.md body lacked a `Total Phases:` field (the no-op write guard skipped the frontmatter resync). (#2640)
