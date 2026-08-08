---
type: Changed
pr: 3199
---
**Live-plan counting now has one owner, so `superseded` plans stop being scheduled and nested-layout phases stop reporting zero** — `scanPhasePlans` is the sole source of which plans exist and which are outstanding. Twenty-one call sites that re-derived it from filenames now route through it, so a plan marked `status: superseded` is no longer scheduled into an execute-phase wave, phases using the nested `plans/` layout no longer report zero plans, and stray summaries no longer inflate completion. (#3183)
