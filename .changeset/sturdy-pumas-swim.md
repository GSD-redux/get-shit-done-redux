---
type: Fixed
pr: 0
---
**`state resolve-blocker`, `state update-progress`, `state record-session`, `roadmap update-plan-progress`, and `roadmap annotate-dependencies` now report the real reason for a no-op** — declining paths named the wrong condition, discarded already-computed values, or (in two cases) falsely reported success when nothing changed; all now report accurately and emit a `[gsd-tools] WARNING:` stderr disclosure. (#3957)
