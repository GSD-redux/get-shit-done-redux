---
type: Changed
pr: 3389
---
**`execute-phase` now warns before the first commit lands on the base branch under the `none` branching strategy** — previously nothing flagged it, so commits could accumulate on the integration branch for an entire phase before anyone noticed. (#3158)
