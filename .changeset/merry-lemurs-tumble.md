---
type: Fixed
pr: 2813
---
**EoS Registry entries carrying the documented `effortSurface` axis are no longer rejected** — the registry validator required an exact eight-key axes object, so an entry that faithfully mirrored its upstream descriptor's optional ninth `effortSurface` key (`argv` or `none`, added by ADR-1239 amendment #2481) failed validation outright. (#2810)
