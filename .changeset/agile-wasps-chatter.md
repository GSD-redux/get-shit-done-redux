---
type: Fixed
pr: 4373
---
**`/gsd-update --reapply` no longer re-grafts customizations that upstream already adopted** — the documented `Incorporated` per-file status is now computed by a deterministic pre-flight classifier (hash-validated pristine baseline + every significant user-added line already present verbatim in the new version), so superseded patches are reported as already upstream instead of being silently re-applied on every future update cycle. (#4136)
