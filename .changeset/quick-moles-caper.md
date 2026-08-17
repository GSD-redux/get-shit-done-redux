---
type: Fixed
pr: 0
---
**`state` writes no longer shrink progress.total_phases to the started-phase count when ROADMAP.md is absent** — with no readable roadmap, every state command persisted the on-disk phase-directory count as the declared total (only phases that had started counted, so a 5-phase project read 50-100% complete with 3-4 phases unstarted); the stored frontmatter total now wins, with a warning, and `state json` reports the same preserved value. (#3573)
