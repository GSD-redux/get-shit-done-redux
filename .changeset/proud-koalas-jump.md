---
type: Fixed
pr: 4476
---
**Sequential phase execution stays on the orchestrator's checkout** — non-isolated executors now receive the orchestrator's validated root as a literal prompt pin and halt loudly before any write or commit when their actual root differs, instead of silently committing onto whatever checkout their spawn cwd resolved to. (#4254)
