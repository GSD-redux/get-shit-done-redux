---
type: Fixed
pr: 4117
---
**Codex installs no longer ship a hook that cannot load** — with `--codex`, `gsd-context-monitor.js` was staged without the `hooks/lib/` helpers it requires, so it failed with a missing-module error at load, before its own error handling, on every event Codex registers it for. The install still reported success, so the only symptom was a Codex session erroring on each prompt. The helpers a Codex-bundled hook needs are now derived from what the staged scripts actually require, followed through helpers that require other helpers, rather than from a hand-maintained list that could not keep up: the same list had gone stale once already, which is how this broke. Helpers no Codex hook requires are still not shipped, and a hook whose helper is genuinely missing from the source now fails the install loudly instead of installing something that cannot run. Full-bundle runtimes and Cursor are unaffected — Cursor's staged set is byte-identical. (#4087) (#4098)
