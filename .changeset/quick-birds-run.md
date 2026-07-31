---
type: Fixed
pr: 2905
---
**`/gsd-code-review --fix` now honors `workflow.use_worktrees`** — when the setting is `false`, the fixer edits and commits in the main checkout instead of creating a git worktree (matching the other writer workflows), and the spec forbids `rm -rf` on a possible Windows reparse point so an improvised worktree teardown can no longer delete the real `node_modules`. The REVIEW-FIX report also records where verification ran.
