---
type: Changed
pr: 3209
---
**A truncated milestone window is no longer reported as an empty milestone** — `roadmap analyze` now emits a `scope` field (`complete`/`truncated`/`unscoped`/`unreadable`) so `phase_count: 0` from a genuinely fresh milestone is distinguishable from a window that closed before reaching the roadmap's phase sections, and `milestone complete` refuses to archive on a truncated window instead of moving every phase directory in the project. (#3184)
