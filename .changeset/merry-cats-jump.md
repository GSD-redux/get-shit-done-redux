---
type: Changed
pr: 3278
---
**Install scope is now resolved once, as a value** — the installer and the modules downstream of it no longer each re-derive whether an install is global or local from a bare string. One module owns the scope axis and reports its config home, its per-scope settings file, and whether it requires a consent record. No behavior changes for any install. (#2870)
