---
type: Fixed
pr: 0
---
**Auto-chain phase completion now runs the same post-processing as a normal transition** (#1526) — completing a phase via `/gsd:execute-phase` (auto-chain) previously skipped the transition workflow's graduation scan, session-continuity, project-reference, accumulated-context, and current-position updates, leaving project state different from a normal transition. execute-phase now delegates post-completion processing to the transition workflow (post-completion mode: skips re-verify + re-running `phase.complete` to avoid a double-write). Identity/standalone transition behavior is unchanged.
