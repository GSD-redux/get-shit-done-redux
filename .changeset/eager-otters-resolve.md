---
type: Fixed
pr: 3930
---
**`gsd capability install` resolves `requires` and `runtimeCompat` against the real capability set** — install-time cross-capability validation was seeded with a map containing only the capability being installed, so any non-empty `requires` failed with `requires "<id>" which does not exist` even when the dependency was a first-party capability that was installed, enabled and active, and a `runtimeCompat` naming a concrete runtime (`claude`, `codex`, …) failed the same way; only `requires: []` and the `"*"` wildcard could be installed. Install now validates against first-party capabilities plus the committed capabilities already installed in the scopes the loader composes, matching what load-time validation has always done. (#3929)
