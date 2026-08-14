---
type: Changed
pr: 0
---
**Gap-closure planning no longer documents a completion marker nothing reads** — the planner emitted `## GAP CLOSURE PLANS CREATED` but no workflow had a dispatch branch for it, so completion was always detected via the `gap_closure: true` fix-plan artifacts anyway; the dead marker is retired and the artifact route (verify-work `--gaps` spawn → plans → `execute-phase --gaps-only`) is now the documented contract. (#3440)
