---
type: Fixed
pr: 3933
---
**`/gsd-capture --backlog` no longer scatters backlog items across per-item branches** — `query commit`'s phase-branching arm now treats `999.x`/`0.x` backlog sentinels as non-phases, so a backlog capture commits on the current branch instead of silently creating and switching to a `gsd/phase-999.*` branch per item. (#3734)
