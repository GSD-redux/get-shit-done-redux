---
type: Fixed
pr: 3725
---
**In-process installer calls can no longer reach your real home** — a runtime kind with a global `home` override (codex skills → `$HOME/.agents`) resolves from `os.homedir()`, not from the caller's config dir, so a test that sandboxed only its target directory pruned every `gsd-*` skill from the developer's real `~/.agents/skills` while the suite still passed and the manifest still reported a healthy install. All six writers that resolve a kind `home` now refuse when a `node --test` run would land inside the real home, compared by filesystem identity rather than pathname and decided on where the write resolves rather than how it is spelled. Two limits are named in the source rather than papered over: a subordinate bind mount of the real directory into a sandbox is not detectable without mount-table introspection, and on a host with no readable passwd entry the guard trusts a caller-set marker. Real installs are unaffected. (#3712)
