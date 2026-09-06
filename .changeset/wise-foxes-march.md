---
type: Fixed
pr: 4416
---
**macOS todo rendering no longer drops the Needs clause under long temp paths** — the 240-char bound is now deterministic w.r.t. base-path length. (#4384 regression)
