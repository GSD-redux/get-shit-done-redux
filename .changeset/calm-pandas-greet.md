---
type: Fixed
pr: 3725
---
**In-process installer calls can no longer reach your real home** — a runtime kind with a global `home` override (codex skills → `$HOME/.agents`) resolves from `os.homedir()`, not from the caller's config dir, so a test that sandboxed only its target directory pruned every `gsd-*` skill from the developer's real `~/.agents/skills` while the suite still passed and the manifest still reported a healthy install. Every writer that resolves a kind `home` now refuses when a `node --test` run would land inside the real home, compared by filesystem identity rather than pathname. Real installs are unaffected. (#3712)
