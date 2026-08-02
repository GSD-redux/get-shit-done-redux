---
type: Fixed
pr: 2815
---
**`phase complete` no longer advances `current_phase` into a backlog phase** — sentinel `999.x` phases are skipped when computing the next phase, so completing the last active phase completes the milestone instead of jumping to the backlog. (#2786)
