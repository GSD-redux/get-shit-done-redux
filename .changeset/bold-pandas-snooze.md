---
type: Added
pr: 0
---
**Verify-command path grounding for phase planning** — a plan's `<automated>` verify command whose target directory does not exist (or holds no `package.json`) is now caught deterministically before execution instead of being hand-reasoned by the plan checker, which previously prescribed wrong replacement paths. The planner also inherits the nearest prior phase's proven verify commands at every context window, not only above 500k. (#2401)
