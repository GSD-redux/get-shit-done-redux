---
type: Fixed
pr: 3008
---
**Phases no longer leak archived data from another workstream** — resolving a phase in one workstream whose own directory doesn't exist yet no longer falls back to an unrelated workstream's (or a flat-mode project's) same-numbered archived phase; it correctly resolves as pending. (#2855)
