---
type: Fixed
pr: 4240
---
**`quick-batch --resume` no longer duplicates work after a coordinator crash** — a crash between an item's executor finishing and its merge could previously cause resume to dispatch a second executor into a new worktree, silently orphaning the first one's completed work. Resume now recognizes an already-executed item and routes it straight to merge.
