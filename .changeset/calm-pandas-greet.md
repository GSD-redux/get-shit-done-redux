---
type: Changed
pr: 4237
---
**`/gsd-update` now stops when it cannot resolve an installed update target** — use the installer explicitly for a fresh install. This includes a custom `--config-dir` whose directory name matches no known runtime and has no runtime marker file or env var (previously silently defaulted to `claude`; now intentionally unresolved). (#4153)
