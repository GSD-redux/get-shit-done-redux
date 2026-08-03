---
type: Changed
pr: 3019
---
**Flag-gated workflow guidance is now actually loaded on demand** — `/gsd-plan-phase` reads its PRD-express, ADR-ingest, reviews-prerequisite, research-only and chunked-planning guidance only when the matching flag or config is active, instead of always inlining all six branches. This also repairs `/gsd-execute-phase --wave`, whose section gating never took effect because the workflow never forwarded the flag to the init bundle, so wave-filtering guidance was silently skipped on every run. (#2993)
