---
type: Fixed
pr: 4080
---
**`query commit` no longer resurrects a merged-and-deleted phase/milestone branch** — a commit resolving to a phase/milestone branch name that was already merged (via `--no-ff`, squash, or rebase merge) and deleted now commits in place instead of silently re-creating the branch and landing the commit there.
