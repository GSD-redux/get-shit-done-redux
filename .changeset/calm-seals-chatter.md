---
type: Added
pr: 3
---
**Quick planning now hosts `plan:pre` planner contributions.** `/gsd-quick` (and `--full` / `--validate`) renders `plan:pre` before it spawns its planner and injects every active contribution whose `into` names the planner role, the same way `/gsd-plan-phase` already does. (#3778)
