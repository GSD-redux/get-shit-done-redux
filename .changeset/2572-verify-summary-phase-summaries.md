---
type: Changed
pr: 2685
---
**Phase SUMMARYs are now checked against what actually landed on disk** — the artifact check that `verify-summary` has always applied to the research SUMMARY now runs against every phase `SUMMARY.md` too, and `/gsd-health` reports advisory `W025` when a summary claims files that are not there. Previously the check was wired to exactly two call sites, both pointed at `.planning/research/SUMMARY.md`, so the summaries that actually assert "I created these files" were never verified by anything. Advisory only: it appends to `warnings[]` and never blocks phase completion. Commit references are deliberately not reported — the hash pattern matches any hex-shaped token in prose, which is too loose to surface. (#2572)
