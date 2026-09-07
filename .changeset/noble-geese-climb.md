---
type: Fixed
pr: 4364
---
**`/gsd-update --reapply` no longer reports no_baseline when a hash-matching gsd-pristine/ snapshot is stored without the gsd-core/ prefix** — the verifier and the installer now resolve the baseline by the recorded SHA-256 and relocate the orphaned snapshot to its canonical path on the next update, so the correct baseline is finally consumed instead of sitting unusable forever. (#4145)
