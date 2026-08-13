---
type: Changed
pr: 3407
---
**`state validate`'s `warnings` are now coded diagnostics, and the `drift` field is gone** — each entry is a `{code, severity, message, remedy}` object (seven codes, `S001`-`S007`) naming exactly what STATE.md disagrees with the filesystem about and how to fix it, instead of a bare string. The separate `drift` object every response used to carry is removed entirely; every condition it used to report (a conflicting phase reference, a missing phases directory, a plan-count mismatch, a stale executing status) is now one of the seven coded warnings, so no information is lost, it's just structured. `valid` and `scope` are unchanged.
