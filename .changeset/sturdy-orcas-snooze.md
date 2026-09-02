---
type: Fixed
pr: 4173
---
**Fixed the coverage gate OOM-crashing on every push to `next`.** The scripts/ coverage-floor check invoked c8's `check-coverage` subcommand, whose handler silently drops the async-merge flag even when it's passed (unlike its `report` sibling, which honors it) — the same OOM class as #4068, but this third script slipped through that fix because adding the flag alone wasn't enough here. Routing the check through `c8 report --check-coverage` instead makes the async-merge flag actually take effect, so coverage now merges incrementally instead of loading every shard's raw data into memory at once and blowing the 8GB CI heap ceiling. (#4172)
