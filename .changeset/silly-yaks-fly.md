---
type: Fixed
pr: 0
---
**Completing a phase with `features.global_learnings` enabled now produces the phase's LEARNINGS.md automatically and copies it to the global store** — previously three shipped consumers read an artifact nothing ever generated, and the copy command read a project-root path the extractor never wrote, so the store stayed empty even after manual extraction. Extraction and copy failures never block completion; with the gate off (the default) behavior is unchanged. (#3683)
