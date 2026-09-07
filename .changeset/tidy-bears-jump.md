---
type: Fixed
pr: 4504
---
**`config-set --dry-run` now actually previews instead of writing** — the flag was silently accepted and ignored, so a probing call still mutated `.planning/config.json` for real; a second dry-run's `previousValue` proved the first had persisted. Both mutating branches (a real set, and the `config-set <key> null` unset path) now honor `--dry-run`, reporting a `dry_run: true` / `would_update` or `would_unset` preview with the current value and writing nothing. Validation and secret masking run identically whether or not `--dry-run` is passed. (#4444)
