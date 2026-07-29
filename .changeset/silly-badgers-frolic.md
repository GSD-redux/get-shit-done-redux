---
type: Fixed
pr: 2693
---
**A commit whose `git add` fails now says so, instead of partially committing or reporting "nothing to commit"** — when staging failed (an unwritable index in a linked worktree, permissions, or a timeout), GSD discarded the error: a multi-file request silently committed only the paths that happened to stage, and a total failure surfaced as `nothing_to_commit` or a downstream pathspec error naming an innocent file. Staging failures are now collected and reported as `staging_failed` (or `staging_timeout`) with the offending file and git's original stderr, before any commit is attempted, and the index is rolled back to its prior state. Applies to scoped (`--files`) commits, default `.planning/` commits, and sub-repo commits alike. (#2608)
