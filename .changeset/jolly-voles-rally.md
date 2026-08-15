---
type: Fixed
pr: 0
---
**Items left unresolved when a milestone closes are no longer invisible to every later audit** — `query audit-open`'s four phase-scoped scanners read only `.planning/phases/`, so once a milestone closed and its phase directories moved to `.planning/milestones/vX.Y-phases/`, any UAT gap, verification gap, context question or deferred item still open at that moment vanished from the pre-close audit permanently. In a fully-archived project the scanners returned nothing at all, which is indistinguishable from a clean tree — and because the audit sums every category into one `has_open_items` boolean, that could report a clean close it had not verified. All four now scan the archived milestone directories as well, and each item says which milestone it came from. (#3458)
