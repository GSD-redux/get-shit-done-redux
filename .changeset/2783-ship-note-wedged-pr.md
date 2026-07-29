---
type: Fixed
pr: 2818
---
**`/gsd-ship` now detects and recovers a PR wedged by the ship-note commit** — when the `[ci skip]` ship note leaves required checks unstarted, ship re-triggers CI instead of leaving the PR unmergeable. (#2783)
