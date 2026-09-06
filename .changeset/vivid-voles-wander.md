---
type: Added
pr: 4346
---
**Opt-in concurrent per-plan planners in chunked mode** — `/gsd-plan-phase --chunked` can now dispatch the per-plan planner Tasks within one outline Wave concurrently instead of one at a time, via `planning.chunked_parallel` (default `false`). Gated on the runtime's negotiated dispatch capacity, so hosts that cannot usefully background multiple agents stay serial regardless of the setting. (#3777)
