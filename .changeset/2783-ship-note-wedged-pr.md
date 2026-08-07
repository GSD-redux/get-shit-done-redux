---
type: Fixed
pr: 2818
---
**`/gsd-ship` now detects and recovers a PR wedged by the ship-note commit** — when the `[ci skip]` ship note leaves required checks unstarted, ship re-triggers CI instead of leaving the PR unmergeable. (#2783)

*Note: This introduces a latency tradeoff. All `/gsd-ship` invocations now poll GitHub PR state for up to 15 seconds to ensure the commit was processed and check if recovery is needed, even for repositories without required checks.*
