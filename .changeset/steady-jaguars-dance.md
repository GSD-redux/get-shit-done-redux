---
type: Fixed
pr: 3428
---
**`roadmap.analyze` now reports the real phase count instead of a silent `phase_count: 0`** when a CLOSED milestone heading sits between the active milestone heading and its own phase-detail sections. A prior refactor (#3184) already added a `scope` discriminator so the empty result was distinguishable from a genuinely empty milestone; this closes the other half of the issue — the consuming resume gate (`workflows/next.md` Route 0) iterates `.phases[]`, so an empty array silently disarmed the safety invariant regardless of the scope field. When the scoped window comes back empty, is non-COMPLETE scope, and phase directories exist on disk, the query re-scans the shipped-milestone-stripped document and populates the phase list while keeping `scope` non-COMPLETE so the result remains flagged as best-effort. (#3165)
