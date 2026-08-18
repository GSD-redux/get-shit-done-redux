---
type: Added
pr: 0
---
**A lint rule now keeps Windows binary resolution in one place** — re-implementing PATH/PATHEXT lookup outside the platform seam is rejected at lint time, so the four divergent resolvers epic #3411 removed cannot quietly come back. No change to how GSD behaves at runtime. (#3619)
