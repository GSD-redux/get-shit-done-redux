---
type: Fixed
pr: 4311
---
**Codex skill edits are backed up on update** — `gsd-file-manifest.json` skills paths now resolve at the runtime's real skills root (`~/.agents/skills`), so user modifications to Codex skills are detected, backed up to `gsd-local-patches/`, and verified by the reapply gate instead of being silently overwritten. (#4086)
