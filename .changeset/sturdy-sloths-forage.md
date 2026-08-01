---
type: Fixed
pr: 2968
---
**Published installs no longer crash on a script that can't load** — `scripts/gen-emitted-baseline.cjs` shipped in the npm tarball but required three modules from `tests/` (which does not ship), producing `MODULE_NOT_FOUND` at load time. The script is repo-only CI tooling and is now excluded from the tarball. A class-extinction guard test ensures no shipped script can require outside the shipped tree going forward. (#2858)
