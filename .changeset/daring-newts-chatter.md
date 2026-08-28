---
type: Fixed
pr: 4013
---
**`--config-dir` installs no longer plan removals of the default home's live legacy install** — the legacy get-shit-done-cc cleanup is scoped to the resolved config dir when `--config-dir` redirects the install (scan, shared cache, and per-package cache alike), the `--dry-run` preview shows the same scoped plan the real install would apply, and `--no-legacy-cleanup` skips the scan entirely. (#3799)
