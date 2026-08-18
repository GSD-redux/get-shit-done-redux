---
type: Fixed
pr: 3525
---

**`uat_path` is now pinned to the phase's own UAT artifact instead of being picked by unsorted directory-listing order** — both `uat_path` projections (`init plan-phase` and `init phase-op`) selected the phase's `*-UAT.md` with a bare first-match `.find()` that had no phase-membership check and no ordering, so a stray or cross-phase `04-UAT.md` sitting in phase 03's directory could become phase 03's `uat_path`, and which file won was filesystem-dependent (creation order on APFS, hash order on ext4/XFS) — meaning two machines on the same commit could emit different `uat_path` values for the same phase, sending downstream workflows to read another phase's UAT state. Both sites now route through a shared phase-pinned resolver (`resolveUatFile`, sibling of the `resolveVerificationFile` rule from #3357/#3492): the phase's own `<token>-UAT.md` always wins, otherwise the alphabetically-first dashed candidate, deterministically on every machine. (#3518)
