---
type: Fixed
pr: 4001
---
**`/gsd-progress` no longer presents archived milestones\' verification debt as current-milestone debt** — the Verification Debt warning segments by the audit\'s `archived_milestone` stamp (current vs still-open-in-archived-mileses), keeps the archived segment visible with its own label, and no longer silently reads zero on large audits (`@file:` payload unwrap). (#3782)
