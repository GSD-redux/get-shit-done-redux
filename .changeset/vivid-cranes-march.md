---
type: Fixed
pr: 3953
---
**`/gsd-plan-phase` no longer hard-blocks on a CONTEXT.md whose decision titles wrap** — a `<decisions>` bullet whose bold lead-in runs across a line break is now read as the one decision it is, instead of counting as an unparseable bullet that forced the decision-coverage gate to `could-not-parse`.
