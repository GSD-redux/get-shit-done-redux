---
type: Added
pr: 3934
---
**Quick planning now preserves `plan:pre` guidance across revisions.** `/gsd-quick` renders one hook snapshot and reuses its planner-targeted contributions for the initial planner and `--full`/`--validate` revision planner. Non-planner contributions are omitted. Because security enforcement is enabled by default, Quick plans may now receive `<threat_model>` guidance unless `workflow.security_enforcement` is disabled. (#3778)
