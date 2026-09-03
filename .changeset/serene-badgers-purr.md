---
type: Fixed
pr: 4216
---
**Legacy Quick Tasks tables migrate automatically** — a STATE.md Quick Tasks table in a pre-registry column format (which `quick-tasks-append` rejects) is now repaired onto the canonical schema by the new `quick-tasks-migrate` command, run automatically before the first append in `/gsd-quick` and `/gsd-fast`; lossless (unmapped columns keep their data in Description), silent no-op when canonical or absent. (#3730)
