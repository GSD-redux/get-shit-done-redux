---
type: Fixed
pr: 0
---
**Unusable `last_activity` now emits a diagnostic** — a present-but-unparseable `last_activity` in STATE.md silently suppressed the idle-stranded recommendation. The fallback (`stale_activity: false`) stays for continuity, but a `last_activity_unparseable` warning is now emitted so the degradation is visible. (#3099)
