---
type: Fixed
pr: 0
---
**GSD no longer creates a `hooks/` directory in pi installs** — pi reserves that name for its deprecated extension location and warned on every startup; the shared hook bundle now installs to `gsd-hooks/` instead, and an upgrade migration retires the old directory. (#3023)
