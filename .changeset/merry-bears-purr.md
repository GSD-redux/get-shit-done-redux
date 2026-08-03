---
type: Changed
pr: 3013
---
**Documented the widened `when=` vocabulary and the per-workflow section manifest.** `docs/reference/workflow-fragments.md` now lists all 14 closed `when=` atoms, the two admission gates a new atom must clear, the manifest artifact's per-workflow `{workflows:{<name>:[...]}}` shape (absent key = degraded, empty array = computed-empty), and that boolean-flag membership in `InvocationFacts.flags` is token-presence, not value-truthiness. Also added the missing `--reset-phase-numbers` flag to `/gsd-new-milestone`'s argument-hint. (#2992)
