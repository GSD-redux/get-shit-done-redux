---
type: Fixed
pr: 0
---
**`query commit` no longer silently switches to a phase/milestone branch** — `git checkout -b` both created AND switched HEAD, resurrecting merged-and-deleted phase branches. Now uses `git branch` (create-only, no switch); the commit always lands on the current branch. Callers that want to be on the phase branch should use `execute-phase`'s branching step. (#3079)
