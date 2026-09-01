---
type: Fixed
pr: 4158
---
**`/gsd-quick` research dispatch uses the researcher persona and model tier** — the quick flow's research step no longer injects the planner persona and planner model into `gsd-phase-researcher`; `init quick` now emits `researcher_model` and the workflow resolves `AGENT_SKILLS_RESEARCHER`, matching `/gsd-plan-phase`. (#3936)
