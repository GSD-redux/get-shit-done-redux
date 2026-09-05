---
type: Fixed
pr: 4235
---
**`~/.gsd/defaults.json` is now honored for runtime resolution inside projects** — every resolution key it sets (`model_profile`, `model_overrides`, `model_policy`, `effort`, `granularity`, the workflow toggles, and the rest of the set) is merged per key behind `.planning/config.json`: a project key still wins on collision, and a key only the global file sets is honored instead of being silently dropped because a project config exists. This is a behavior change for anyone whose global file sets a key their project config does not — until now that key was inert and the built-in default applied; it now takes effect, exactly as it already did in a directory with no `.planning/`. The `#3532` "global keys are shadowed" stderr warning is retired, since nothing is shadowed any more. (#4071)
