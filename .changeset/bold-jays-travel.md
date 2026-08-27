---
type: Changed
pr: 3925
---
**Diagnostics stop reporting a clean result when they had to drop data to get one.** `intel query`'s recursive search now stops at 48 levels and marks the result `truncated: true` instead of quietly matching arbitrarily deep (a match past the ceiling now reports truncated rather than found, and no longer crashes with a stack overflow past ~12000 levels); `phase-plan-index` now names an unresolved `depends_on` token in its own warning instead of blaming the plan's declared `wave:` for a dependency edge the tool itself dropped, and that warning's own token is escaped so an attacker-authored token cannot forge a second warning line; and a code-review run where every lane failed no longer writes a `REVIEWS.md` synthesized from nothing, preserving each lane's raw output first. (#3885)
