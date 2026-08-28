---
type: Fixed
pr: 0
---
**The isolation guard no longer denies sequential dispatches a workstream explicitly opted out of** — the sentinel-absent fallback now reads `workflow.use_worktrees` through the same project/workstream-aware ladder as the resolver and `config-get`, instead of the flat root config where a workstream-local opt-out was invisible. (#3972)
