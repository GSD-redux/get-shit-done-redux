---
type: Added
pr: 4323
---
**`/gsd:code-review` can now optionally corroborate its internal review with registered external reviewer lanes** — new roster-derived flags dispatch a bounded, read-only source review through each selected lane; findings are re-verified against real source and folded into the existing `REVIEW.md`. Bare `/gsd:code-review` (no flag) is unchanged.
