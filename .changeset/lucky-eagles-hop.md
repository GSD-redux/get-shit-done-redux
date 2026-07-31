---
type: Fixed
pr: 2909
---
**`findProjectRoot` no longer silently resolves to a parent project across a git-repo boundary** — when invoked from a nested git repository that has no `.planning/` of its own, resolution stays within the caller's repo (or falls back to the start directory) instead of crossing into an ancestor GSD project. The existing plain-descendant and co-located `.git`+`.planning` cases are unchanged.
