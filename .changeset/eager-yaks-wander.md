---
type: Fixed
pr: 0
---
**`gsd-core/references/` and `commands/` are now covered by the bare-command guard** — the #2751 guard only ever scanned `agents/` and `gsd-core/workflows/`, so 47 bare `gsd-tools <verb>` calls sat unguarded in the two directories it never looked at. They are rewritten to `gsd_run`, the guard now scans all four surfaces, and `commands/` came under the launcher propagator so its preambles are single-sourced instead of hand-pasted — `graphify.md` had five copies. (#2751)
