---
type: Fixed
pr: 2779
---
**`/gsd-spec-phase` now actually runs its edge-completeness and prohibition-completeness probes** — every gate-passed path reaches Step 5.5, and Step 5.5 now falls through to Step 5.6 instead of jumping past it. Previously all four gate-passed transitions went straight to SPEC generation and Step 5.5's own "all edges resolved" gate skipped the prohibition probe, so a SPEC could ship with an empty Edge Coverage section, an empty Prohibitions section, or both — and a weaker model following the prose literally would never notice. Since the probes are what carry must-NOT constraints and data-shape edges into `must_haves`, the plan and the verifier inherited the gap too. (#2733)
