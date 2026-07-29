---
type: Fixed
pr: 2729
---
**An unreadable ROADMAP.md is no longer reported as a brand-new project** — a permission or I/O error reading `.planning/ROADMAP.md` used to return the same "phase not found" and `v1.0 / milestone` values as a project that simply has no roadmap yet, so workflows synthesized a blank phase or skipped requirement extraction with no signal. GSD now names the unreadable file on stderr while returning exactly what it returned before. A project that genuinely has no ROADMAP.md stays silent. (#1881)
