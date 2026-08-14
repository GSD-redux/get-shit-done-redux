---
type: Changed
pr: 3439
---
**`/gsd-progress` no longer implies re-execution when only the verification report is missing** — the routing message now explains that running `/gsd-execute-phase` on a historical phase resumes at the verification gates and does not re-run already-summarized plans, and softens the unrecognized-status message to acknowledge an intentional non-standard marker. (#1762)
<!-- docs-exempt: advisory routing text only; no docs page documents this specific message today, so there is nothing to keep in sync -->
