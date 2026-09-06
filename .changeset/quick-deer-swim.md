---
type: Fixed
pr: 4368
---
**`update-context` no longer reports a global install as LOCAL when the shell is sitting in `$HOME`** — the `--config-dir` fast path derived scope from cwd alone, so `<cwd>/.claude` and `<home>/.claude` being one directory made `/gsd-update` from the home directory run the installer with `--local` against a global install (switching to `settings.local.json` and triggering the #338 migration). The fast path and the full cascade now resolve THE global candidate through one function and dedup against it, so an env-directed global (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...) correctly leaves a same-named directory under `$HOME` as a project-local install. (#4197)
