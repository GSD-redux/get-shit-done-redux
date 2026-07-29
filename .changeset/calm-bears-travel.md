---
type: Fixed
pr: 2833
---
**Workstream-scoped config reads now inherit from the project root config** — `config-get` under an active workstream (`GSD_WORKSTREAM`) now resolves a key absent from the workstream's own config to the project-root value before falling back to schema defaults, instead of reporting 'Key not found'. A workstream config still overrides root for any key it sets; root only fills gaps. Previously a key set only at root was silently lost under a workstream, causing shipped workflow boolean guards (e.g. use_worktrees, plan_review_convergence) to apply their hardcoded fallback and silently invert the user's setting.
