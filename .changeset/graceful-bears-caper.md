---
type: Changed
pr: 4029
---
**Removed a dead code path** — `listMilestoneArchiveDirs` (caller-less since the Phase-12 snapshot migration) and its test seam are gone; the #1883 unreadable-milestones regression suite now pins the live planning-snapshot path. (#3813)
