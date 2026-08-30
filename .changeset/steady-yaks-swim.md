---
type: Fixed
pr: 4080
---
Fix: `query commit` no longer resurrects a merged-and-deleted phase/milestone branch (silently re-creating it and committing on it) when a new commit resolves to the same branch name.
