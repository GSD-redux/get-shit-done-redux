---
type: Fixed
pr: 3371
---
**`gsd-tools validate health` and `validate consistency` no longer flag sentinel phase directories (999.x backlog/interim, 0.x drafts)** — the disk-vs-roadmap comparison now applies the `isSentinelPhaseId` guard that the phase commands already had. Sentinel ids are defined as never-on-roadmap, so a `999-interim` directory previously produced a permanent spurious W007 ("Phase 999 exists on disk but not in ROADMAP.md", advice to add it to the roadmap or delete it — both wrong) and a spurious "Gap in phase numbering: N → 999". Real (non-sentinel) orphans and genuine numbering gaps still warn. (#3225)
