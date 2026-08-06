---
type: Fixed
pr: 3130
---
**`phase complete` no longer advances `next_phase` into 999.x backlog headings** — the roadmap heading scan (stage 2 of the next-phase cascade) accepted any higher-numbered heading without checking the sentinel convention, so a `Phase 999.1: Backlog Item` heading was treated as the next real phase. Sentinel phase ids (999.x backlog, 0.x drafts) are now skipped. (#2786)
