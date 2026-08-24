---
type: Fixed
pr: 0
---
**`gsd-core/references/` is now covered by the bare-command guard** — the #2751 guard only ever scanned `agents/` and `gsd-core/workflows/`, so 37 bare `gsd-tools <verb>` calls sat unguarded in a directory it never looked at. They now call the canonical `gsd_run` launcher, and the guard scans references too. (#2751)
