---
type: Fixed
pr: 3405
---
**`validate health --backfill` now works without also passing `--repair`** — previously it silently did nothing unless `--repair` was also set, due to an unreachable internal gate.
