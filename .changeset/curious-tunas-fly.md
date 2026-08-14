---
type: Fixed
pr: 3437
---
code-review: every phase diff-base derivation now uses the same anchored, POSIX-portable phase-mention grep. Fixes wrong review scope from /gsd:code-review when a phase has no SUMMARY artifacts: the reviewer diff_base and the fallow --changed-since base no longer resolve to old unrelated commits whose messages merely contain the phase digits, and the anchored search now actually matches on macOS (the previous \b word boundary is not POSIX ERE and silently matched nothing there).
