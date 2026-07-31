---
type: Fixed
pr: 2900
---
**A clean Codex install now applies balanced model settings to agent TOMLs on the first run** — `~/.gsd/defaults.json` (`resolve_model_ids` + `runtime`) is now written before agent TOML generation, so the runtime-aware model resolver knows the target runtime during the first pass. Previously a second install was required. (#2834)
