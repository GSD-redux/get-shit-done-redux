---
type: Fixed
pr: 2621
---
**`GSD_AUDIT=1` now actually produces an audit trail** — the reference dispatch logger is wired onto the live command seam, so opting in yields the documented structured stderr line and the `.planning/.gsd-trace.jsonl` audit trail. Previously the seam built its dispatch hub without a logger, so it fell back to a no-op and the opt-in signal was inert with no indication why. With observability off, dispatch output is byte-for-byte unchanged. (#2620)
