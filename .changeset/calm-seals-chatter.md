---
type: Added
pr: 3934
---
**Quick planning now hosts `plan:pre` planner contributions.** `/gsd-quick` renders `plan:pre` once before its initial planner and injects every active planner-targeted contribution in registry order. `--full` and `--validate` reuse that same snapshot in revision planner prompts. Because security enforcement is enabled by default, its contribution can require generated `<threat_model>` blocks with configured ASVS and severity values; contributions targeting other roles remain omitted from Quick's planner prompts. (#3778)
