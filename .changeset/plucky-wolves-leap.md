---
type: Fixed
pr: 3491
---
phase.complete no longer rewrites STATE.md frontmatter stopped_at with a stale body 'Stopped at:' line: the completion now refreshes the session continuity line it implies ('Phase N complete, ready to plan Phase N+1') and applies the standard field-preservation policy on its atomic commit path (also extended to milestone complete / state sync). state record-session no longer reports 'Stopped At' as updated when the value is already current.
