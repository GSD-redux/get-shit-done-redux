---
type: Fixed
pr: 0
---
Windows/Claude Code: /gsd-update and re-running the installer now migrate stale `.sh` managed hook commands (gsd-validate-commit, gsd-graphify-update, gsd-session-state, gsd-phase-boundary) in settings.json/settings.local.json to the current bash-runner-omission format — removing the redundant nested bash that the pre-#580/#3393 shape spawns on every hook fire. Custom user hooks are never touched.
