---
type: Fixed
pr: 4005
---
**`/gsd-quick` no longer authorizes edit/verification scope from historical state** — when scope depends on mutable external state (a fresh merge index, PR diffs, the working tree), the planner must observe it live or keep the plan's scope conditional; cached PR-diff paths and stale recovery notes are investigation guidance only, so a merge-conflict task can no longer provisionally "authorize" 65 historical paths. (#3786)
