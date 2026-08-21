---
type: Fixed
pr: 3728
---
**`/gsd:plan-phase` no longer writes gitignored install-mirror paths into plans** — `files_modified` and artifact paths are now verified against `git ls-files` and resolved to tracked source (e.g. a plugin's own tree) instead of a runtime mirror under `.gsd/capabilities/`, whose edits died on every capability sync; paths inherited from PATTERNS.md are re-verified so one mirror path can no longer self-propagate across phases. (#3645)
