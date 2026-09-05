---
type: Added
pr: 0
---
**Reviews-mode disposition records now have a canonical shape** — planning a phase with `/gsd-plan-phase --reviews` writes accepted/deferred review findings into PLAN.md under one `## Review Dispositions Ledger` section instead of each planner run improvising its own format. Entries are grouped per review round and cite REVIEWS.md lines as `L##@{sha}` so a reference still resolves after the next round rewrites the file. (#3806)
