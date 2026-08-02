---
type: Changed
pr: 2984
---
**Windsurf command install no longer fails on an oversized description, and emitted artifacts are now checked against their host's byte limit** — the Windsurf workflow converter truncates a long description instead of throwing, matching the bound its sibling skill converter already applied, and a new per-runtime cap gate measures what each runtime actually receives rather than what the source files weigh. (#2931)
