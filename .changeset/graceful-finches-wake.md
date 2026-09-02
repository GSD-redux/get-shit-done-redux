---
type: Fixed
pr: 4092
---
**`gsd-node-runner.sh` no longer triggers a permanent, unclearable "⚠ stale hooks" warning** — it was registered in `MANAGED_HOOKS` but shipped without its `gsd-hook-version` header, so up-to-date installs always flagged it as stale.
