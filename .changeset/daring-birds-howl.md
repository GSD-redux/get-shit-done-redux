---
type: Fixed
pr: 3195
---
**`/gsd-update --sync` no longer fails with MODULE_NOT_FOUND** — the sync-skills workflow shelled out to `gsd-core/bin/install.js`, which the installer never copies. Now uses `gsd-tools query skills-root` (which IS shipped) to resolve skills roots. (#3024)
