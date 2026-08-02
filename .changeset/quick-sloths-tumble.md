---
type: Fixed
pr: 2985
---
**Project configs no longer inherit `runtime` from the machine-wide `~/.gsd/defaults.json`** — on machines with 2+ runtimes installed (e.g. Codex + Claude Code), the last installer's `runtime` value poisoned every new project, resolving agents to wrong model IDs. The key is now excluded from the defaults spread. (#2840)
