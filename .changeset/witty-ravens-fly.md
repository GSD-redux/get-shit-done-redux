---
type: Fixed
pr: 4486
---
**W002 no longer fires on quoted commands in STATE.md** — the health check read GSD's own command names (like ``/gsd-execute-phase 5`` in a ledger row) and anything inside backticks as phase references, so healthy multi-workstream projects reported degraded with false warnings; under an active workstream the warning now also says its declared-phase list is workstream-scoped (`... are declared in workstream <name>`) instead of making an unqualified project-wide claim. (#4257)
