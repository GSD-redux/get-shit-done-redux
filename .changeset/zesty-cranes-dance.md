---
type: Fixed
pr: 4230
---
**Executor commit claims are measured, not narrated** — the executor records the pre-plan HEAD and derives `commits:` from `git rev-list` (HALT if code sits uncommitted), `/gsd:verify-work` reconciles the claim against git with the same instrument and flags a mismatch as a BLOCKER, and HANDOFF's `uncommitted_files` comes from `git status --porcelain`. (#3968)
