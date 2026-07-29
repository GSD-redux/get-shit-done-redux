---
type: Changed
pr: 2676
---
**Raw and calibrated phase-estimate token counts are now distinct types** — the two states of an estimate (the planner's uncorrected projection and the same figure with the project's calibration factor applied) could previously be swapped at any seam without complaint, because both are plain positive integers. That produced two shipped defects in epic #1952: a doubly-applied correction (factor squared) and a calibration loop that measured against its own output and never converged. Both are now compile errors. No behavior, output, or schema change. (#2671)
