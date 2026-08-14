---
type: Changed
pr: 3443
---
**Gap-closure planning no longer documents a completion marker nothing reads** — the planner emitted `## GAP CLOSURE PLANS CREATED` but no workflow had a dispatch branch for it, so completion was always detected via the `gap_closure: true` fix-plan artifacts anyway; the dead marker is retired and the artifact route (verify-work `--gaps` spawn → plans → `execute-phase --gaps-only`) is now the documented contract. (#3440)
<!-- docs-exempt: the retirement and its replacement contract live in gsd-core/references/planner-guidance.md, the runtime-loaded reference for this seam; no docs/ page documents the marker today (verified) and none is owed for its removal -->
