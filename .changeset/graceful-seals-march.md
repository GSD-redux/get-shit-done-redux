---
type: Added
pr: 3540
---
**`~/.gsd/defaults.json` shadowing is now diagnosed instead of silent** — in any project with a `.planning/config.json`, global model-side keys (`model_profile`, `model_overrides`, `models`, `dynamic_routing`, `runtime`, …) were silently ignored for model resolution; a file named `defaults.json` applied to no real project with no signal. GSD now prints a one-time stderr warning naming the shadowed keys. Resolution precedence is unchanged; global `effort` keeps working via effort sync and never warns. (#3532)
