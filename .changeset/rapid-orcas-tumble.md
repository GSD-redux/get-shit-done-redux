---
type: Added
pr: 3601
---
**Per-phase `commit_docs` override** — set `phase_commit_docs.<phase-id>` to commit one phase's `.planning/` artifacts (e.g. an architecture phase) while keeping other phases local, without flipping the project-wide `commit_docs` switch. (#3587)
