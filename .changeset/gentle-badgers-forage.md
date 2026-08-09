---
type: Fixed
pr: 3230
---
**`state.record-session` no longer shrinks your phase count** — a project whose ROADMAP declares more phases than it has directories on disk (phases 5 and 6 planned but not started yet) had `progress.total_phases` silently overwritten with the directory count, converging on the right number only once the last phase directory happened to exist. A flat roadmap carrying an ordinary heading like `## Progress` was being misread as milestone-sectioned. Known limit: two milestone sections carrying no version token, no status marker and not the word "Milestone" are still not detected as sectioning. (#3204)
