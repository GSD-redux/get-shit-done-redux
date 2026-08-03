---
type: Changed
pr: 0
---
**Planning invocations no longer load branch guidance they will not take.** `/gsd-plan-phase` now conditionally reads its PRD-express, ADR-ingest, reviews-prerequisite, research-only, and chunked-planning-mode guidance only when the matching flag or config is active, shrinking a typical invocation's loaded context instead of always inlining all six branches. (#2993)
