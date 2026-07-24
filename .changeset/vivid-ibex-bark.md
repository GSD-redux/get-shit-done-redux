---
type: Fixed
pr: 2621
---
Wire the reference dispatch logger onto the live command seam so GSD_AUDIT=1 (and config.audit.enabled) actually produce the documented structured stderr line and .planning/.gsd-trace.jsonl audit trail. With observability off, dispatch output is unchanged.
