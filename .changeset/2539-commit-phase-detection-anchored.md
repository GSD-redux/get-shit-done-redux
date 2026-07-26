---
type: Fixed
pr: 2669
---
**`query commit --files` no longer silently checks out the wrong phase branch mid-commit** — the phase-token extraction is now anchored to the directory segment under `.planning/phases/` and reuses the project-code-aware `extractPhaseToken` helper instead of an unanchored regex, so a `project_code` ending in a digit (e.g. `PROJECT_V2`) no longer makes `…/PROJECT_V2-07-name/…` match the `2-` inside `V2-` and resolve to the wrong phase. The commit-path branch auto-switch also no longer silently force-switches an already-checked-out working branch onto a different existing phase branch (it creates-if-absent only, per the original `#1278` intent); the only prior trace of the silent switch was a `git reflog` entry. (#2539)
