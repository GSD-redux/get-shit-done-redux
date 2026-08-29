---
type: Fixed
pr: 0
---
**`audit-uat` sees workstream phases again** — the audit now enumerates all three phase-archive layouts (flat `milestones/vX.Y-phases/`, archived workstream `milestones/ws-*/phases/`, and active workstream `workstreams/<ws>/milestones/`), with workstream entries labeled `<ws>/<version>` so acknowledge-by-milestone stays unambiguous. A project using workstreams no longer gets an All Clear audit while items are open, and `--ws` no longer empties the report. Phase lookups keep their #2855 workstream scoping unchanged. (#3804)
