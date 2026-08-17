---
type: Fixed
pr: 0
---
**Shipped workflow/agent citations resolve again** — 43 backticked `references/<name>.md` cites across 19 shipped files were dead pointers from every install location; all repaired to the canonical `gsd-core/references/<name>.md` form, and a new sweep gate fails the build on any future bare cite across the runtime-loaded trees. (#3576)
