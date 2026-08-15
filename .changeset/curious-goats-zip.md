---
type: Fixed
pr: 0
---
**Three shell guards that could never fire now do** — the planner's Walking Skeleton mode never activated on any project, phase planning recorded an empty requirement list instead of `TBD`, and completing a milestone with no phase summaries could hang instead of finishing. Each read a value that came back empty on success, so the fallback written to handle it was unreachable. (#3409)
