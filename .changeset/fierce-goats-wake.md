---
type: Fixed
pr: 4369
---
**Managed hooks no longer break on a keg-only or unlinked Homebrew node** — the installer now probes `<prefix>/bin/node` before baking it into a hook command and falls back to the running node when that symlink does not exist, matching the fnm, mise and volta branches. (#4137)
