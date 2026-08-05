---
type: Fixed
pr: 3082
---
**`/gsd-audit-uat` now sees archived phases and table-shaped artifacts** — three silent false negatives are fixed: (1) the audit scanned only `.planning/phases/`, so a project whose milestones had been archived to `.planning/milestones/<version>-phases/` silently omitted those phases, and one with ALL phases archived hard-errored with "No phases directory found" instead of reporting its outstanding items; (2) a `deferred-items.md` recording entries as a GFM table yielded zero items; (3) a table-shaped `## Gaps` section likewise yielded zero items. Results now carry `archived_milestone` so consumers can label provenance. Same false-negative family as #2286/#2287, one document shape further out. (#2766)
